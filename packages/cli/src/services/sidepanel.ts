export * as Sidepanel from "./sidepanel"

// The opencode side panel browser extension (packages/open-extension) finds the background service
// through a Chrome native messaging host: `opencode sidepanel host`. This module registers that host
// for installed Chromium browsers. The extension ships its own opencode plugin and hands it to the
// host, so the plugin always matches the installed extension version.
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

export type Browser = { name: string; bundleID?: string; directory: string }

/** Chromium browsers whose profile directory exists, with where their native messaging hosts go. */
export function browsers(): Browser[] {
  const home = homedir()
  if (process.platform === "darwin")
    return [
      { name: "Google Chrome", bundleID: "com.google.Chrome", dir: "Google/Chrome" },
      { name: "Google Chrome Beta", bundleID: "com.google.Chrome.beta", dir: "Google/Chrome Beta" },
      { name: "Google Chrome Canary", bundleID: "com.google.Chrome.canary", dir: "Google/Chrome Canary" },
      { name: "Chromium", bundleID: "org.chromium.Chromium", dir: "Chromium" },
      { name: "Brave", bundleID: "com.brave.Browser", dir: "BraveSoftware/Brave-Browser" },
      { name: "Microsoft Edge", bundleID: "com.microsoft.edgemac", dir: "Microsoft Edge" },
      { name: "Vivaldi", bundleID: "com.vivaldi.Vivaldi", dir: "Vivaldi" },
      { name: "Helium", bundleID: "net.imput.helium", dir: "net.imput.helium" },
      { name: "Arc", bundleID: "company.thebrowser.Browser", dir: "Arc/User Data" },
    ].map((item) => ({
      name: item.name,
      bundleID: item.bundleID,
      directory: path.join(home, "Library/Application Support", item.dir),
    }))
  const config = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")
  return [
    { name: "Google Chrome", dir: "google-chrome" },
    { name: "Google Chrome Beta", dir: "google-chrome-beta" },
    { name: "Chromium", dir: "chromium" },
    { name: "Brave", dir: "BraveSoftware/Brave-Browser" },
    { name: "Microsoft Edge", dir: "microsoft-edge" },
    { name: "Vivaldi", dir: "vivaldi" },
    { name: "Helium", dir: "net.imput.helium" },
  ].map((item) => ({ name: item.name, directory: path.join(config, item.dir) }))
}

export function manifestPath(browser: Browser) {
  return path.join(browser.directory, "NativeMessagingHosts", `${HOST_NAME}.json`)
}

export const paths = Effect.fnUntraced(function* () {
  const global = yield* Global.Service
  return {
    /** Browsers start hosts without arguments we control, so a wrapper runs `opencode sidepanel host`. */
    wrapper: path.join(global.data, "sidepanel", "host"),
    plugin: path.join(global.config, "plugins", PLUGIN_FILE),
    /** Written by the host on each connection, for `status` and `install`. */
    state: path.join(global.state, "sidepanel.json"),
  }
})

/** Writes the wrapper and a host manifest for every installed browser. */
export const install = Effect.fn("cli.sidepanel.install")(function* () {
  const fs = yield* FileSystem.FileSystem
  const files = yield* paths()
  // A release is a single binary. A development run executes the CLI source with bun, which needs the
  // CLI package directory as its working directory to pick up its bunfig.
  const script = process.argv[1]?.endsWith(".ts") ? process.argv[1] : undefined
  const launch = script
    ? `cd ${JSON.stringify(path.resolve(path.dirname(script), ".."))} && exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
    : `exec ${JSON.stringify(process.execPath)}`
  yield* fs.makeDirectory(path.dirname(files.wrapper), { recursive: true })
  yield* fs.writeFileString(files.wrapper, `#!/bin/sh\n${launch} sidepanel host\n`)
  yield* fs.chmod(files.wrapper, 0o755)
  const manifest = JSON.stringify(
    {
      name: HOST_NAME,
      description: "opencode side panel: finds the opencode background service",
      path: files.wrapper,
      type: "stdio",
      allowed_origins: EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
    },
    null,
    2,
  )
  const installed = yield* Effect.filter(browsers(), (browser) => fs.exists(browser.directory))
  yield* Effect.forEach(installed, (browser) =>
    fs
      .makeDirectory(path.dirname(manifestPath(browser)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(manifestPath(browser), manifest + "\n"))),
  )
  return installed
})

/** Removes everything install and the host wrote. */
export const uninstall = Effect.fn("cli.sidepanel.uninstall")(function* () {
  const fs = yield* FileSystem.FileSystem
  const files = yield* paths()
  const removed = yield* Effect.filter(browsers(), (browser) => fs.exists(manifestPath(browser)))
  yield* Effect.forEach(removed, (browser) => fs.remove(manifestPath(browser)))
  yield* Effect.forEach([files.wrapper, files.plugin, files.state], (file) => fs.remove(file).pipe(Effect.ignore))
  return removed
})

/**
 * Opens the extension's store page in the default browser when it is one of the installed Chromium
 * browsers, else in the first installed one. Returns the browser's name, or undefined when not published.
 */
export const openStore = Effect.fn("cli.sidepanel.openStore")(function* (installed: Browser[]) {
  if (!STORE_URL) return undefined
  if (process.platform !== "darwin") {
    Bun.spawnSync(["xdg-open", STORE_URL])
    return "your default browser"
  }
  const preferred = defaultBrowserID()
  const browser = installed.find((item) => item.bundleID?.toLowerCase() === preferred) ?? installed[0]
  Bun.spawnSync(["open", "-b", browser.bundleID!, STORE_URL])
  return browser.name
})

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

/** When the extension last reached the host, if ever. */
export const lastConnected = Effect.fn("cli.sidepanel.lastConnected")(function* () {
  const fs = yield* FileSystem.FileSystem
  const files = yield* paths()
  const text = yield* fs.readFileString(files.state).pipe(Effect.orElseSucceed(() => ""))
  return Option.getOrUndefined(decodeState(text))?.connected
})

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ connected: Schema.Finite })))
