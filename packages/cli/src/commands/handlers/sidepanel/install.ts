import { EOL } from "os"
import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Sidepanel } from "../../../services/sidepanel"
import { ServiceConfig } from "../../../services/service-config"
import { Service } from "@opencode/client/effect/service"

export default Runtime.handler(
  Commands.commands.sidepanel.commands.install,
  Effect.fn("cli.sidepanel.install")(function* () {
    const installed = yield* Sidepanel.install()
    // The extension connects to the background service, so make sure one is running.
    yield* Service.ensure(yield* ServiceConfig.options())
    const lines = installed.length
      ? ["Registered the side panel helper for:", ...installed.map((browser) => `  ${browser.name}`)]
      : ["No supported browser found (Chrome, Brave, Edge, Arc, Vivaldi, Helium, Chromium)."]
    const opened = installed.length ? yield* Sidepanel.openStore(installed) : undefined
    process.stdout.write(
      [
        "",
        ...lines,
        "",
        opened
          ? `Opened the extension page in ${opened}. Add it, then open the side panel from the toolbar.`
          : "Load the extension from its page in the Chrome Web Store, or for development load packages/open-extension/dist unpacked.",
        "Run `opencode sidepanel status` to check the connection.",
        "",
      ].join(EOL),
    )
  }),
)
