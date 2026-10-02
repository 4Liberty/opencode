import { EOL } from "os"
import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Sidepanel } from "../../../services/sidepanel"

export default Runtime.handler(
  Commands.commands.sidepanel.commands.uninstall,
  Effect.fn("cli.sidepanel.uninstall")(function* () {
    const removed = yield* Sidepanel.uninstall()
    process.stdout.write(
      (removed.length
        ? `Removed the side panel helper from: ${removed.map((browser) => browser.name).join(", ")}`
        : "The side panel helper was not registered.") +
        EOL +
        "Remove the extension itself from your browser's extensions page." +
        EOL,
    )
  }),
)
