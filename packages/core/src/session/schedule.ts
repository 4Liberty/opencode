export * as SessionSchedule from "./schedule.js"

import { Context, Duration, Effect, Fiber, Layer, Option, Schema } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { KV } from "../kv.js"
import { Session } from "../session.js"
import { SessionSchema } from "./schema.js"

const Entry = Schema.Struct({ interval: Schema.Number, text: Schema.String })
export type Entry = typeof Entry.Type
const decodeEntry = Schema.decodeUnknownOption(Entry)
const prefix = "session.schedule/"

export interface Interface {
  /** Saves a recurring prompt for a Session and (re)starts its timer. */
  readonly set: (sessionID: SessionSchema.ID, entry: Entry) => Effect.Effect<void>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * Starts timers for every saved schedule. Timers live in this global service rather than in a
   * Location, so they keep firing while the Session's Location is unloaded; each prompt loads it on
   * demand. Inert until called: the managed server calls it once at boot.
   */
  readonly resume: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSchedule") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const sessions = yield* Session.Service
    const scope = yield* Effect.scope
    const running = new Map<SessionSchema.ID, Fiber.Fiber<void>>()

    const stop = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const fiber = running.get(sessionID)
      running.delete(sessionID)
      if (fiber) yield* Fiber.interrupt(fiber)
    })

    const start = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, entry: Entry) {
      yield* stop(sessionID)
      const loop: Effect.Effect<void> = Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(entry.interval))
        const exists = yield* sessions.prompt({ sessionID, text: entry.text, delivery: "queue" }).pipe(
          Effect.as(true),
          Effect.catchTag("Session.NotFoundError", () => Effect.succeed(false)),
          Effect.catchCause((cause) =>
            Effect.logWarning("scheduled prompt failed", { sessionID, cause }).pipe(Effect.as(true)),
          ),
        )
        // A deleted Session ends its schedule instead of retrying forever.
        if (!exists) return yield* kv.remove(prefix + sessionID)
        return yield* loop
      })
      running.set(sessionID, yield* Effect.forkIn(loop, scope))
    })

    return Service.of({
      set: Effect.fnUntraced(function* (sessionID, entry) {
        yield* kv.set(prefix + sessionID, entry)
        yield* start(sessionID, entry)
      }),
      remove: Effect.fnUntraced(function* (sessionID) {
        yield* stop(sessionID)
        yield* kv.remove(prefix + sessionID)
      }),
      resume: Effect.gen(function* () {
        const saved = yield* kv.scan({ prefix })
        yield* Effect.forEach(
          saved.entries,
          (item) => {
            const entry = decodeEntry(item.value)
            if (Option.isNone(entry)) return Effect.void
            return start(SessionSchema.ID.make(item.key.slice(prefix.length)), entry.value)
          },
          { discard: true },
        )
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node, Session.node] })
