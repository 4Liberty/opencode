import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live("probes a directory without booting its location or masking a missing path", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const existing = path.join(tmp.path, "existing")
    const missing = path.join(tmp.path, "removed")
    const file = path.join(tmp.path, "file")
    const loop = path.join(tmp.path, "loop")
    yield* Effect.promise(async () => {
      await fs.mkdir(existing)
      await fs.writeFile(file, "content")
      await fs.symlink(loop, loop)
    })
    const server = yield* startServer(tmp.path)
    const probe = (directory?: string) =>
      Effect.promise(async () => {
        const url = new URL("/api/location/probe", server.base)
        if (directory !== undefined) url.searchParams.set("directory", directory)
        const response = await fetch(url, { headers: server.headers })
        return { status: response.status, body: await response.json() }
      })

    expect(yield* probe(existing)).toEqual({ status: 200, body: { exists: true } })
    expect(yield* probe(missing)).toEqual({ status: 200, body: { exists: false } })
    expect(yield* probe(file)).toEqual({ status: 200, body: { exists: true } })
    expect((yield* probe(path.join(file, "child"))).status).toBe(500)
    expect((yield* probe(loop)).status).toBe(500)
    expect((yield* probe()).status).toBe(400)
    const loaded = yield* Effect.promise(async () =>
      (await fetch(new URL("/api/debug/location", server.base), { headers: server.headers })).json(),
    )
    expect(loaded).toEqual([])
  }),
)
