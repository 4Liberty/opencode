import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Effect, Schedule, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

const ListResponse = Schema.Struct({ data: Schema.Array(Agent.Info) })
const DefaultResponse = Schema.Struct({
  location: Schema.Struct({ directory: Schema.String }),
  data: Schema.optional(Agent.Info),
})

it.live("returns the default agent for each location", () =>
  Effect.gen(function* () {
    const global = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-agent-default-global-")))
    const cases = [
      { config: { default_agent: "reviewer", agents: { reviewer: { mode: "primary" } } }, expected: "reviewer" },
      { config: { agents: { reviewer: { mode: "primary" } } }, expected: "build" },
      { config: { default_agent: "missing", agents: { reviewer: { mode: "primary" } } }, expected: "build" },
      { config: { default_agent: "reviewer", agents: { reviewer: { hidden: true } } }, expected: "build" },
      { config: { default_agent: "reviewer", agents: { reviewer: { mode: "subagent" } } }, expected: "build" },
    ]
    const projects = yield* Effect.forEach(cases, (item) =>
      Effect.gen(function* () {
        const project = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-agent-default-")))
        yield* Effect.promise(() => fs.writeFile(path.join(project.path, "opencode.json"), JSON.stringify(item.config)))
        return { directory: project.path, expected: item.expected }
      }),
    )
    const server = yield* startServer(global.path)
    const get = (pathname: string, directory: string) =>
      Effect.gen(function* () {
        const url = new URL(pathname, server.base)
        url.searchParams.set("location[directory]", directory)
        const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
        expect(response.status).toBe(200)
        return yield* Effect.promise(() => response.json())
      })

    yield* Effect.forEach(projects, (project) =>
      Effect.gen(function* () {
        // Config agents register during plugin activation, after the location is served.
        yield* get("/api/agent", project.directory).pipe(
          Effect.map((body) => Schema.decodeUnknownSync(ListResponse)(body).data),
          Effect.filterOrFail((agents) => agents.some((agent) => agent.id === "reviewer")),
          Effect.retry(Schedule.spaced("10 millis")),
          Effect.timeout("2 seconds"),
        )
        const body = Schema.decodeUnknownSync(DefaultResponse)(yield* get("/api/agent/default", project.directory))
        expect(body.location.directory).toBe(project.directory)
        expect(body.data?.id).toBe(Agent.ID.make(project.expected))
      }),
    )
  }),
)
