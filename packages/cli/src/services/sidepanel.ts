export * as Sidepanel from "./sidepanel"

// The opencode side panel browser extension (packages/open-extension) finds the background service
// through a Chrome native messaging host: `opencode sidepanel host`. This module registers that host
// for installed Chromium browsers. The extension ships its own opencode plugin and hands it to the
// host, so the plugin always matches the installed extension version.
//
// Browser coverage follows ChatGPT's browser extension host (Chrome, Chrome for Testing, Chromium,
// Edge, Brave, Opera, Vivaldi on macOS, Linux, and Windows), plus Helium, Arc, and Chrome Beta/Canary.
import { Effect, FileSystem, Option, Schema } from "effect"
import { homedir } from "node:os"
import path from "node:path"
import { Global } from "@opencode/util/global"

export const HOST_NAME = "ai.opencode.sidepanel"
/** Extension IDs the host answers. The unpacked build's manifest key fixes its ID. */
export const EXTENSION_IDS = ["afeafocngkodbmaipcngoamamfmekgfo"]
/** Chrome Web Store listing; set once the extension is published. */
export const STORE_URL: string | undefined = undefined
export const PLUGIN_FILE = "sidepanel.ts"
/** Larger plugin sources are refused; the real one is a few kilobytes. */
export const PLUGIN_MAX_BYTES = 512 * 1024
/** Windows finds hosts through these per-user registry keys; other Chromium browsers read Chrome's. */
const REGISTRY_ROOTS = ["HKCU\\Software\\Google\\Chrome", "HKCU\\Software\\Microsoft\\Edge"]

/**
 * A browser is installed when its profile directory exists. On macOS and Linux its host manifests go in
 * each `manifests` directory; on Windows they are found through the registry instead.
 */
export type Browser = { name: string; bundleID?: string; profile: string; manifests: string[] }

export function browsers(): Browser[] {
  const home = homedir()
  if (process.platform === "darwin") {
    const support = (dir: string) => path.join(home, "Library/Application Support", dir)
    const browser = (name: string, bundleID: string, dirs: string[]): Browser => ({
      name,
      bundleID,
      profile: support(dirs[0]),
      manifests: dirs.map((dir) => path.join(support(dir), "NativeMessagingHosts")),
    })
    return [
      browser("Google Chrome", "com.google.Chrome", ["Google/Chrome"]),
      browser("Chrome for Testing", "com.google.chrome.for.testing", [
        "Google/Chrome for Testing",
        "Google/ChromeForTesting",
      ]),
      browser("Google Chrome Beta", "com.google.Chrome.beta", ["Google/Chrome Beta"]),
      browser("Google Chrome Canary", "com.google.Chrome.canary", ["Google/Chrome Canary"]),
      browser("Chromium", "org.chromium.Chromium", ["Chromium"]),
      browser("Microsoft Edge", "com.microsoft.edgemac", ["Microsoft Edge"]),
      browser("Brave", "com.brave.Browser", ["BraveSoftware/Brave-Browser"]),
      browser("Opera", "com.operasoftware.Opera", ["com.operasoftware.Opera"]),
      browser("Vivaldi", "com.vivaldi.Vivaldi", ["Vivaldi"]),
      browser("Helium", "net.imput.helium", ["net.imput.helium"]),
      browser("Arc", "company.thebrowser.Browser", ["Arc/User Data"]),
    ]
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    const roaming = process.env.APPDATA ?? path.join(home, "AppData", "Roaming")
    return [
      { name: "Google Chrome", profile: path.join(local, "Google", "Chrome", "User Data"), manifests: [] },
      { name: "Microsoft Edge", profile: path.join(local, "Microsoft", "Edge", "User Data"), manifests: [] },
      { name: "Brave", profile: path.join(local, "BraveSoftware", "Brave-Browser", "User Data"), manifests: [] },
      { name: "Opera", profile: path.join(roaming, "Opera Software", "Opera Stable"), manifests: [] },
      { name: "Vivaldi", profile: path.join(local, "Vivaldi", "User Data"), manifests: [] },
    ]
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")
  // Chrome-family builds honor CHROME_CONFIG_HOME before XDG_CONFIG_HOME.
  const chrome = process.env.CHROME_CONFIG_HOME ?? xdg
  const browser = (name: string, root: string, dir: string): Browser => ({
    name,
    profile: path.join(root, dir),
    manifests: [path.join(root, dir, "NativeMessagingHosts")],
  })
  return [
    browser("Google Chrome", chrome, "google-chrome"),
    browser("Google Chrome Beta", chrome, "google-chrome-beta"),
    browser("Google Chrome Unstable", chrome, "google-chrome-unstable"),
    browser("Chrome for Testing", chrome, "google-chrome-for-testing"),
    browser("Chromium", chrome, "chromium"),
    browser("Microsoft Edge", xdg, "microsoft-edge"),
    browser("Brave", xdg, "BraveSoftware/Brave-Browser"),
    browser("Opera", xdg, "opera"),
    browser("Vivaldi", xdg, "vivaldi"),
    browser("Helium", xdg, "net.imput.helium"),
  ]
}

export const paths = Effect.fnUntraced(function* () {
  const global = yield* Global.Service
  const directory = path.join(global.data, "sidepanel")
  return {
    /** Browsers start hosts without arguments we control, so a wrapper runs `opencode sidepanel host`. */
    wrapper: path.join(directory, process.platform === "win32" ? "host.bat" : "host"),
    /** Windows reads the manifest from wherever its registry value points. */
    manifest: path.join(directory, `${HOST_NAME}.json`),
    plugin: path.join(global.config, "plugins", PLUGIN_FILE),
    /** Written by the host on each connection, for `status`. */
    state: path.join(global.state, "sidepanel.json"),
  }
})

/** Writes the wrapper and registers the host for every installed browser. Returns those browsers. */
export const install = Effect.fn("cli.sidepanel.install")(function* () {
  const fs = yield* FileSystem.FileSystem
  const files = yield* paths()
  yield* fs.makeDirectory(path.dirname(files.wrapper), { recursive: true })
  yield* fs.writeFileString(files.wrapper, wrapper())
  if (process.platform !== "win32") yield* fs.chmod(files.wrapper, 0o755)
  const manifest =
    JSON.stringify(
      {
        name: HOST_NAME,
        description: "opencode side panel: finds the opencode background service",
        path: files.wrapper,
        type: "stdio",
        allowed_origins: EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
      },
      null,
      2,
    ) + "\n"
  const installed = yield* Effect.filter(browsers(), (browser) => fs.exists(browser.profile))
  if (process.platform === "win32") {
    yield* fs.writeFileString(files.manifest, manifest)
    REGISTRY_ROOTS.forEach((root) =>
      Bun.spawnSync(["reg", "add", registryKey(root), "/ve", "/t", "REG_SZ", "/d", files.manifest, "/f"]),
    )
    return installed
  }
  yield* Effect.forEach(
    installed.flatMap((browser) => browser.manifests),
    (directory) =>
      fs
        .makeDirectory(directory, { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(path.join(directory, `${HOST_NAME}.json`), manifest))),
  )
  return installed
})

/** Browsers the host is registered for. On Windows, every installed browser once the registry key exists. */
export const registered = Effect.fn("cli.sidepanel.registered")(function* () {
  const fs = yield* FileSystem.FileSystem
  if (process.platform === "win32") {
    const exists = REGISTRY_ROOTS.some(
      (root) => Bun.spawnSync(["reg", "query", registryKey(root), "/ve"]).exitCode === 0,
    )
    return exists ? yield* Effect.filter(browsers(), (browser) => fs.exists(browser.profile)) : []
  }
  return yield* Effect.filter(browsers(), (browser) =>
    Effect.map(
      Effect.forEach(browser.manifests, (directory) => fs.exists(path.join(directory, `${HOST_NAME}.json`))),
      (found) => found.some(Boolean),
    ),
  )
})

/** Removes everything install and the host wrote. Returns the browsers it was registered for. */
export const uninstall = Effect.fn("cli.sidepanel.uninstall")(function* () {
  const fs = yield* FileSystem.FileSystem
  const files = yield* paths()
  const removed = yield* registered()
  if (process.platform === "win32")
    REGISTRY_ROOTS.forEach((root) => Bun.spawnSync(["reg", "delete", registryKey(root), "/f"]))
  yield* Effect.forEach(
    browsers().flatMap((browser) => browser.manifests),
    (directory) => fs.remove(path.join(directory, `${HOST_NAME}.json`)).pipe(Effect.ignore),
  )
  yield* Effect.forEach([files.wrapper, files.manifest, files.plugin, files.state], (file) =>
    fs.remove(file).pipe(Effect.ignore),
  )
  return removed
})

/**
 * Opens the extension's store page in the default browser. On macOS, when the default is not one of the
 * installed Chromium browsers, the first installed one opens it. Returns where it opened, or undefined
 * when the extension is not published yet.
 */
export const openStore = Effect.fn("cli.sidepanel.openStore")(function* (installed: Browser[]) {
  if (!STORE_URL) return undefined
  if (process.platform === "win32") {
    Bun.spawnSync(["cmd", "/c", "start", "", STORE_URL])
    return "your default browser"
  }
  if (process.platform !== "darwin") {
    Bun.spawnSync(["xdg-open", STORE_URL])
    return "your default browser"
  }
  const preferred = defaultBrowserID()
  const browser = installed.find((item) => item.bundleID?.toLowerCase() === preferred) ?? installed[0]
  Bun.spawnSync(["open", "-b", browser.bundleID!, STORE_URL])
  return browser.name
})

/** When the extension last reached the host, if ever. */
export const lastConnected = Effect.fn("cli.sidepanel.lastConnected")(function* () {
  const fs = yield* FileSystem.FileSystem
  const files = yield* paths()
  const text = yield* fs.readFileString(files.state).pipe(Effect.orElseSucceed(() => ""))
  return Option.getOrUndefined(decodeState(text))?.connected
})

/**
 * The script browsers run. A release is a single binary. A development run executes the CLI source with
 * bun, which needs the CLI package directory as its working directory to pick up its bunfig.
 */
function wrapper() {
  const script = process.argv[1]?.endsWith(".ts") ? process.argv[1] : undefined
  const quote = (value: string) => `"${value}"`
  const command = [process.execPath, ...(script ? [script] : [])].map(quote).join(" ")
  const directory = script ? path.resolve(path.dirname(script), "..") : undefined
  if (process.platform === "win32")
    return `@echo off\r\n${directory ? `cd /d ${quote(directory)}\r\n` : ""}${command} sidepanel host\r\n`
  return `#!/bin/sh\n${directory ? `cd ${quote(directory)} && ` : ""}exec ${command} sidepanel host\n`
}

function registryKey(root: string) {
  return `${root}\\NativeMessagingHosts\\${HOST_NAME}`
}

/** The bundle identifier macOS opens https links with. */
function defaultBrowserID() {
  const result = Bun.spawnSync([
    "plutil",
    "-extract",
    "LSHandlers",
    "json",
    "-o",
    "-",
    path.join(homedir(), "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist"),
  ])
  const handlers = Option.getOrUndefined(decodeHandlers(result.stdout.toString()))
  return handlers?.find((handler) => handler.LSHandlerURLScheme === "https")?.LSHandlerRoleAll?.toLowerCase()
}

const decodeHandlers = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        LSHandlerURLScheme: Schema.optional(Schema.String),
        LSHandlerRoleAll: Schema.optional(Schema.String),
      }),
    ),
  ),
)

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ connected: Schema.Finite })))
