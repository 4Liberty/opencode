export * as SchedulePlugin from "./schedule.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { SessionSchedule } from "../session/schedule.js"

const units = { s: 1_000, m: 60_000, h: 3_600_000 }

export const Plugin = define({
  id: "opencode.schedule",
  effect: Effect.fn(function* (ctx) {
    const schedule = yield* SessionSchedule.Service
    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "schedule",
        description: "repeat a prompt in this session: <30s|15m|2h> <prompt>, or off",
        execute: (input) =>
          Effect.gen(function* () {
            const text = input.prompt.text.trim()
            if (text === "off") return yield* schedule.remove(input.sessionID)
            const match = /^(\d+)([smh])\s+([\s\S]+)$/.exec(text)
            if (!match) return yield* Effect.fail(new Error("Usage: /schedule <30s|15m|2h> <prompt>, or /schedule off"))
            yield* schedule.set(input.sessionID, {
              interval: Number(match[1]) * units[match[2] as keyof typeof units],
              text: match[3],
            })
          }),
      })
    })
  }),
})
