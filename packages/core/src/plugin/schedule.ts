export * as SchedulePlugin from "./schedule.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Duration, Effect, Fiber, Option, Schema, Scope } from "effect"

const Entry = Schema.Struct({ interval: Schema.Number, text: Schema.String })
const decodeEntry = Schema.decodeUnknownOption(Entry)
const units = { s: 1_000, m: 60_000, h: 3_600_000 }

export const Plugin = define({
  id: "opencode.schedule",
  effect: Effect.fn(function* (ctx) {
    const scope = yield* Scope.Scope
    const running = new Map<Session.ID, Fiber.Fiber<void>>()

    const stop = Effect.fn("SchedulePlugin.stop")(function* (sessionID: Session.ID) {
      const fiber = running.get(sessionID)
      running.delete(sessionID)
      if (fiber) yield* Fiber.interrupt(fiber)
    })

    const start = Effect.fn("SchedulePlugin.start")(function* (sessionID: Session.ID, entry: typeof Entry.Type) {
      yield* stop(sessionID)
      const fiber = yield* Effect.sleep(Duration.millis(entry.interval)).pipe(
        Effect.andThen(ctx.session.prompt({ sessionID, text: entry.text, delivery: "queue" })),
        Effect.catchCause((cause) => Effect.logWarning("scheduled prompt failed", { sessionID, cause })),
        Effect.forever,
        Effect.forkIn(scope),
      )
      running.set(sessionID, fiber)
    })

    // Schedules persist in global plugin storage; each location restarts only its own sessions' schedules.
    const saved = yield* ctx.storage.scan({ prefix: "" })
    yield* Effect.forEach(
      saved.entries,
      (item) =>
        Effect.gen(function* () {
          const entry = decodeEntry(item.value)
          if (Option.isNone(entry)) return
          const sessionID = Session.ID.make(item.key)
          const session = yield* ctx.session.get({ sessionID }).pipe(Effect.option)
          if (Option.isNone(session)) return
          if (session.value.location.directory !== ctx.location.directory) return
          if (session.value.location.workspaceID !== ctx.location.workspaceID) return
          yield* start(sessionID, entry.value)
        }),
      { discard: true },
    )

    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "schedule",
        description: "repeat a prompt in this session: <30s|15m|2h> <prompt>, or off",
        execute: (input) =>
          Effect.gen(function* () {
            const text = input.prompt.text.trim()
            if (text === "off") {
              yield* stop(input.sessionID)
              yield* ctx.storage.remove(input.sessionID)
              return
            }
            const match = /^(\d+)([smh])\s+([\s\S]+)$/.exec(text)
            if (!match) return yield* Effect.fail(new Error("Usage: /schedule <30s|15m|2h> <prompt>, or /schedule off"))
            const entry = { interval: Number(match[1]) * units[match[2] as keyof typeof units], text: match[3] }
            yield* ctx.storage.set(input.sessionID, entry)
            yield* start(input.sessionID, entry)
          }),
      })
    })
  }),
})
