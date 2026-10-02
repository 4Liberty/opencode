// Installs the Open Extension native messaging host for every Chromium-family browser on this
// machine. Run from packages/open-extension: `bun run host:install`.
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const name = "ai.opencode.open_extension"
const home = homedir()
const opencode = process.env.OPENCODE_BIN ?? Bun.which("opencode2") ?? Bun.which("opencode")
if (!opencode) throw new Error("opencode is not on PATH. Install it, or set OPENCODE_BIN to its path.")

const manifest = await Bun.file(path.join(import.meta.dir, "../public/manifest.json")).json()
const extensionID = idFromKey(manifest.key)
const target = path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local/share"), "opencode/open-extension")
await mkdir(target, { recursive: true })

// Bundle the host so it keeps working when this checkout moves or is deleted.
const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "host.ts")], target: "bun" })
if (!built.success) throw new AggregateError(built.logs, "Could not bundle the native host.")
await Bun.write(path.join(target, "host.js"), built.outputs[0])

// Browsers start hosts with a minimal environment, so the wrapper pins bun and opencode explicitly.
const wrapper = path.join(target, "open-extension-host")
const searchPath = [...new Set([path.dirname(process.execPath), path.dirname(opencode), "/usr/bin", "/bin"])].join(":")
await writeFile(
  wrapper,
  `#!/bin/sh\nexport PATH="${searchPath}"\nexport OPENCODE_BIN="${opencode}"\nexec "${process.execPath}" "${path.join(target, "host.js")}"\n`,
)
await chmod(wrapper, 0o755)

const browsers =
  process.platform === "darwin"
    ? [
        "Google/Chrome",
        "Google/Chrome Beta",
        "Google/Chrome Canary",
        "Chromium",
        "BraveSoftware/Brave-Browser",
        "Microsoft Edge",
        "Vivaldi",
        "net.imput.helium",
        "Arc/User Data",
      ].map((dir) => path.join(home, "Library/Application Support", dir))
    : ["google-chrome", "google-chrome-beta", "chromium", "BraveSoftware/Brave-Browser", "microsoft-edge", "vivaldi", "net.imput.helium"].map(
        (dir) => path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), dir),
      )
const host = {
  name,
  description: "Open Extension native host: finds the opencode background service",
  path: wrapper,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionID}/`],
}
const installed = await Promise.all(
  browsers
    .filter((dir) => existsSync(dir))
    .map(async (dir) => {
      const hosts = path.join(dir, "NativeMessagingHosts")
      await mkdir(hosts, { recursive: true })
      await writeFile(path.join(hosts, `${name}.json`), JSON.stringify(host, null, 2) + "\n")
      return hosts
    }),
)

// The opencode plugin that gives agents site_scripts tools; opencode loads it from its config directory.
const plugins = path.join(process.env.OPENCODE_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "opencode"), "plugins")
const plugin = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../plugin/open-extension.ts")], target: "bun" })
if (!plugin.success) throw new AggregateError(plugin.logs, "Could not bundle the opencode plugin.")
await mkdir(plugins, { recursive: true })
await Bun.write(path.join(plugins, "open-extension.js"), plugin.outputs[0])

console.log(`Extension ID: ${extensionID}`)
console.log(`opencode plugin: ${path.join(plugins, "open-extension.js")}`)
console.log(`Host: ${wrapper} (opencode: ${opencode})`)
console.log(installed.length ? `Registered for:\n${installed.map((dir) => `  ${dir}`).join("\n")}` : "No supported browsers found.")

/** Chrome derives an unpacked extension's ID from its manifest key: the first 128 bits of SHA-256, as a–p. */
function idFromKey(key: string) {
  const hash = new Bun.CryptoHasher("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)
  return Array.from(hash, (char) => String.fromCharCode(97 + Number.parseInt(char, 16))).join("")
}
