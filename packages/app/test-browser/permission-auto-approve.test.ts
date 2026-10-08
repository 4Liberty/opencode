import { beforeAll, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { Data } from "@opencode/client/solid"
import type { PermissionRequest } from "@opencode/client/promise"
import type { ServerSDK } from "@/runtime/server/client"

let createPermissionAutoApprover: typeof import("../src/session/requests/auto-approve").createPermissionAutoApprover

beforeAll(async () => {
  mock.module("@/settings/model", () => ({
    useSettings: () => ({ permissions: { autoApprove: () => true } }),
  }))
  createPermissionAutoApprover = (await import("../src/session/requests/auto-approve")).createPermissionAutoApprover
})

test("disconnect invalidates permission lists still pending from the old connection", async () => {
  const [status, setStatus] = createSignal("connected")
  const requests: ((value: { data: PermissionRequest[] }) => void)[] = []
  const replied: string[] = []
  const permission = { id: "request", sessionID: "session" } as PermissionRequest
  const sdk = {
    connection: { status },
    event: { on: () => () => {} },
    api: {
      location: { list: async () => [{ directory: "/fixture/loaded" }] },
      session: { active: async () => ({}) },
      permission: {
        request: {
          list: () => new Promise<{ data: PermissionRequest[] }>((resolve) => requests.push(resolve)),
        },
        reply: async ({ requestID }: { requestID: string }) => {
          replied.push(requestID)
        },
      },
    },
  } as unknown as ServerSDK
  const data = { session: { list: () => [] } } as unknown as Data
  const dispose = createRoot((dispose) => {
    createPermissionAutoApprover({ sdk, data })
    return dispose
  })
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  try {
    await flush()
    expect(requests).toHaveLength(1)
    setStatus("reconnecting")
    requests[0]({ data: [permission] })
    await flush()
    expect(replied).toEqual([])
    setStatus("connected")
    await flush()
    expect(requests).toHaveLength(2)
    requests[1]({ data: [permission] })
    await flush()
    expect(replied).toEqual([permission.id])
  } finally {
    dispose()
  }
})
