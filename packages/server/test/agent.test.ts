import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Effect, Schedule, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

const DefaultResponse = Schema.Struct({
  location: Schema.Struct({ directory: Schema.String }),
  data: Schema.NullOr(Agent.Info),
})

it.live("returns the default agent for each location", () =>
  Effect.gen(function* () {
    const global = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-agent-default-global-")))
    const configured = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-agent-default-")))
    const unconfigured = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-agent-default-")))
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(configured.path, "opencode.json"),
        JSON.stringify({ default_agent: "reviewer", agents: { reviewer: { mode: "primary" } } }),
      ),
    )
    const server = yield* startServer(global.path)

    yield* Effect.forEach(
      [
        { directory: configured.path, expected: "reviewer" },
        { directory: unconfigured.path, expected: "build" },
      ],
      (project) =>
        Effect.gen(function* () {
          const url = new URL("/api/agent/default", server.base)
          url.searchParams.set("location[directory]", project.directory)
          const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
          expect(response.status).toBe(200)
          const body = Schema.decodeUnknownSync(DefaultResponse)(yield* Effect.promise(() => response.json()))
          expect(body.location.directory).toBe(project.directory)
          return body.data?.id
        }).pipe(
          // Agents register during plugin activation, after the location is served.
          Effect.filterOrFail((id) => id === project.expected),
          Effect.retry(Schedule.spaced("10 millis")),
          Effect.timeout("2 seconds"),
        ),
    )
  }),
)
