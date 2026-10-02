import { EOL } from "os"
import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { BrowserExtension } from "../../../services/browser-extension"

export default Runtime.handler(
  Commands.commands.browser.commands.uninstall,
  Effect.fn("cli.browser.uninstall")(function* () {
    const removed = yield* BrowserExtension.uninstall()
    process.stdout.write(
      (removed.length
        ? `Removed the opencode Browser helper from: ${removed.map((browser) => browser.name).join(", ")}`
        : "The opencode Browser helper was not registered.") +
        EOL +
        "Remove the extension itself from your browser's extensions page." +
        EOL,
    )
  }),
)
