import { expect } from "bun:test"
import { fullGC, heapStats } from "bun:jsc"
import { Effect, Layer } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { testEffect } from "../../core/test/lib/effect"
import { OpenCode } from "../src/effect"
import { OwnedFetch } from "../src/internal/fetch"

testEffect(Layer.empty).live("releases completed embedded requests while the host stays open", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const client = yield* OpenCode.create({
      app: { version: "request-retention-test" },
      config: { directory: directory.path, project: false, content: "{}" },
      events: { persist: true },
      models: { fetch: false },
      fs: { filewatcher: false },
    })

    fullGC()
    const before = heapStats().objectTypeCounts.Request ?? 0
    for (let index = 0; index < 200; index++) {
      expect((yield* client.server.info()).version).toBe("request-retention-test")
    }

    // Completed response cleanup crosses an event-loop turn in the embedded transport.
    yield* Effect.promise(() => Bun.sleep(100))
    fullGC()
    expect((heapStats().objectTypeCounts.Request ?? 0) - before).toBeLessThan(20)
  }),
)

testEffect(Layer.empty).live("keeps caller abort and host shutdown wired to active requests", () =>
  Effect.promise(async () => {
    const seen: unknown[] = []
    const transport = OwnedFetch.make(
      async (request) => {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => {
              seen.push(request.signal.reason)
              resolve()
            },
            { once: true },
          )
        })
        return new Response("aborted")
      },
      async () => {},
    )
    const controller = new AbortController()
    const first = transport.fetch("http://opencode.local/", { signal: controller.signal })
    controller.abort("caller")
    expect(await first.catch((error: unknown) => error)).toBe("caller")

    const second = transport.fetch("http://opencode.local/")
    const closed = transport.close()
    expect(await second.catch((error: unknown) => error)).toBeInstanceOf(Error)
    await closed
    expect(seen).toEqual(["caller", expect.any(Error)])
  }),
)
