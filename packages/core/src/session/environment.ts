export * as SessionEnvironment from "./environment.js"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Session } from "@opencode/schema/session"

export type Variables = Readonly<Record<string, string>>

export interface Interface {
  readonly get: (sessionID: Session.ID) => Effect.Effect<Variables | undefined>
  readonly set: (sessionID: Session.ID, variables: Variables) => Effect.Effect<void>
  readonly clear: (sessionID: Session.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionEnvironment") {}

const layer = Layer.sync(Service, () => {
  const environments = new Map<Session.ID, Variables>()

  return Service.of({
    get: (sessionID) => Effect.sync(() => environments.get(sessionID)),
    set: (sessionID, variables) =>
      Effect.sync(() => {
        environments.set(sessionID, { ...variables })
      }),
    clear: (sessionID) =>
      Effect.sync(() => {
        environments.delete(sessionID)
      }),
  })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
