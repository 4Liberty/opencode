import { expect, test } from "bun:test"
import type { Data } from "@opencode/client/solid"
import type { LocationRef } from "@opencode/client/promise"
import type { ServerSDK } from "@/runtime/server/client"
import { loadedLocations, permissionLocations, syncInactiveSession } from "./passive"

function fixture() {
  const state = {
    location: { directory: "/fixture/current" } as LocationRef,
    loaded: [] as LocationRef[],
    active: {} as Record<string, { type: "running" }>,
    running: new Set<string>(),
    pending: [] as { type: string }[],
    synced: [] as string[],
    hydrated: [] as string[],
    reads: 0,
    current: true,
    fail: false,
    failSync: false,
    afterSync: () => {},
  }
  const sdk = {
    api: {
      debug: {
        location: {
          list: async () => {
            state.reads++
            if (state.fail) throw new Error("inventory unavailable")
            return state.loaded
          },
        },
      },
      session: { active: async () => state.active },
    },
  } as unknown as ServerSDK
  const data = {
    session: {
      sync: async (id: string) => {
        state.synced.push(id)
        if (state.failSync) throw new Error("metadata unavailable")
        state.afterSync()
      },
      invalidate: () => {},
      get: () => ({ location: state.location }),
      list: () => {
        throw new Error("historical sessions must not be an attention inventory")
      },
      family: () => ["child"],
      status: (id: string) => (state.running.has(id) ? "running" : "idle"),
      pending: { sync: async () => {}, list: () => state.pending },
      permission: {
        sync: async (id: string) => {
          state.hydrated.push(`permission:${id}`)
        },
      },
      form: {
        sync: async (id: string) => {
          state.hydrated.push(`form:${id}`)
        },
      },
    },
  } as unknown as Data
  return { state, sdk, data, current: () => state.current }
}

test("restoring many historical tabs refreshes passive data without acquiring locations", async () => {
  const input = fixture()
  await Promise.all(
    Array.from({ length: 100 }, (_, index) => syncInactiveSession({ ...input, id: `inactive-${index}` })),
  )
  expect(input.state.synced).toHaveLength(100)
  expect(input.state.reads).toBe(1)
  expect(input.state.hydrated).toEqual([])
})

test("loaded idle locations recover attention with Windows path normalization", async () => {
  const input = fixture()
  input.state.location = { directory: "C:\\fixture\\current\\" }
  input.state.loaded = [{ directory: "c:/fixture/current" }]
  await syncInactiveSession({ ...input, id: "idle" })
  expect(input.state.hydrated).toEqual(["permission:idle", "form:idle"])
})

test("a different workspace at the same directory does not authorize hydration", async () => {
  const input = fixture()
  input.state.loaded = [{ ...input.state.location, workspaceID: "other" }]
  await syncInactiveSession({ ...input, id: "idle" })
  expect(input.state.hydrated).toEqual([])
})

test("a running child and a freshly loaded user inbox each recover attention", async () => {
  const running = fixture()
  running.state.running.add("child")
  await syncInactiveSession({ ...running, id: "parent" })
  expect(running.state.hydrated).toHaveLength(2)
  const pending = fixture()
  pending.state.afterSync = () => {
    pending.state.pending = [{ type: "user" }]
  }
  await syncInactiveSession({ ...pending, id: "queued" })
  expect(pending.state.hydrated).toHaveLength(2)
})

test("synthetic inbox entries do not boot historical locations", async () => {
  const input = fixture()
  input.state.pending = [{ type: "synthetic" }]
  await syncInactiveSession({ ...input, id: "idle" })
  expect(input.state.hydrated).toEqual([])
})

test("disposed refreshes cannot hydrate or query inventory after passive sync", async () => {
  const input = fixture()
  input.state.afterSync = () => {
    input.state.current = false
  }
  input.state.running.add("idle")
  await syncInactiveSession({ ...input, id: "idle" })
  expect(input.state.reads).toBe(0)
  expect(input.state.hydrated).toEqual([])
})

test("failed inventory reads refuse hydration and can be retried", async () => {
  const input = fixture()
  input.state.fail = true
  await expect(syncInactiveSession({ ...input, id: "idle" })).rejects.toThrow("inventory unavailable")
  expect(input.state.hydrated).toEqual([])
  input.state.fail = false
  input.state.loaded = [input.state.location]
  await syncInactiveSession({ ...input, id: "idle" })
  expect(input.state.hydrated).toHaveLength(2)
})

test("later inventory reads see newly loaded locations", async () => {
  const input = fixture()
  expect(await loadedLocations(input.sdk)).toEqual([])
  input.state.loaded = [input.state.location]
  expect(await loadedLocations(input.sdk)).toEqual([input.state.location])
  expect(input.state.reads).toBe(2)
})

test("permission recovery includes loaded idle services without enumerating historical sessions", async () => {
  const input = fixture()
  input.state.loaded = [
    { directory: "/fixture/idle", workspaceID: "first" },
    { directory: "/fixture/idle", workspaceID: "second" },
  ]
  input.state.active = { running: { type: "running" } }
  const result = await permissionLocations(input)
  expect(result.complete).toBe(true)
  expect(result.locations).toEqual([input.state.location, ...input.state.loaded])
  expect(input.state.synced).toEqual(["running"])
})

test("failed active-session refreshes cannot recover the cached old location", async () => {
  const input = fixture()
  input.state.active = { moved: { type: "running" } }
  input.state.failSync = true
  const result = await permissionLocations(input)
  expect(result.complete).toBe(false)
  expect(result.locations).toEqual([])
})

test("inventory failures do not expand permission recovery into history", async () => {
  const input = fixture()
  input.state.fail = true
  const result = await permissionLocations(input)
  expect(result.complete).toBe(false)
  expect(result.locations).toEqual([])
})

test("superseded recovery cannot hydrate active sessions", async () => {
  const input = fixture()
  input.state.active = { running: { type: "running" } }
  input.state.current = false
  expect(await permissionLocations(input)).toEqual({ locations: [], complete: true })
  expect(input.state.synced).toEqual([])
})
