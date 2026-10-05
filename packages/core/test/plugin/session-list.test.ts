import { expect } from "bun:test"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

it.live("Effect plugins list filtered sessions with server-style cursors", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const context = yield* PluginHost.make(plugins)
    const first = yield* context.session.create({ title: "match one" })
    yield* context.session.create({ title: "different" })
    const second = yield* context.session.create({ title: "match two" })
    const query = { directory: context.location.directory, limit: 1, order: "asc" as const, search: "match" }
    const page = yield* context.session.list(query)
    expect(page.data.map((session) => session.id)).toEqual([first.id])
    expect(page.cursor.next).toBeDefined()

    const next = yield* context.session.list({ cursor: page.cursor.next, limit: 1 })
    expect(next.data.map((session) => session.id)).toEqual([second.id])
    const previous = yield* context.session.list({ cursor: next.cursor.previous, limit: 1 })
    expect(previous.data.map((session) => session.id)).toEqual([first.id])
    expect(
      yield* context.session.list({ cursor: "invalid" as NonNullable<typeof page.cursor.next> }).pipe(Effect.flip),
    ).toMatchObject({ message: "Invalid cursor" })
  }),
)

it.live("Promise plugins list sessions with server-style cursors", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const context = yield* PluginHost.make(plugins)
    const created = yield* context.session.create({ title: "Review" })

    yield* PluginPromise.fromPromise({
      id: "test.session-list",
      async setup(ctx) {
        const page = await ctx.session.list({ directory: ctx.location.directory, search: "Review", limit: 1 })
        expect(page.data.map((session) => session.id)).toEqual([created.id])
        expect(page.cursor.next).toBeDefined()
        expect(await ctx.session.list({ cursor: page.cursor.next, limit: 1 })).toMatchObject({ data: [] })
      },
    }).effect(context)
  }),
)
