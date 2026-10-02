import { EOL } from "os"
import { Effect, FileSystem } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Sidepanel } from "../../../services/sidepanel"

export default Runtime.handler(
  Commands.commands.sidepanel.commands.status,
  Effect.fn("cli.sidepanel.status")(function* () {
    const fs = yield* FileSystem.FileSystem
    const registered = yield* Effect.filter(Sidepanel.browsers(), (browser) => fs.exists(Sidepanel.manifestPath(browser)))
    const connected = yield* Sidepanel.lastConnected()
    process.stdout.write(
      [
        registered.length
          ? `Helper registered for: ${registered.map((browser) => browser.name).join(", ")}`
          : "Helper not registered. Run `opencode sidepanel install`.",
        connected ? `Extension last connected: ${new Date(connected).toLocaleString()}` : "Extension has not connected yet.",
      ].join(EOL) + EOL,
    )
  }),
)
