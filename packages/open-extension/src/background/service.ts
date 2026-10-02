import type { ServiceInfo, ServiceState } from "../shared/protocol"

/** Native messaging host installed by `bun run host:install`; it reads the opencode service registration. */
export const HOST_NAME = "ai.opencode.open_extension"
const MANUAL_KEY = "manualService"

type HostResponse = { ok: true; url: string; password: string } | { ok: false; error: string }

/** Finds the opencode background service: a manual override if the user set one, else the native host. */
export function createService(changed: (state: ServiceState) => void) {
  let state: ServiceState = { status: "loading" }
  let pending: Promise<ServiceInfo> | undefined
  const set = (next: ServiceState) => {
    state = next
    changed(next)
  }
  const load = async (): Promise<ServiceInfo> => {
    const stored = (await chrome.storage.local.get(MANUAL_KEY))[MANUAL_KEY] as { url: string; password: string } | undefined
    const info: ServiceInfo = stored
      ? { url: stored.url, password: stored.password, source: "manual" }
      : await chrome.runtime.sendNativeMessage(HOST_NAME, { type: "service" }).then(
          (response: HostResponse) => {
            if (!response?.ok) throw new Error(response?.error ?? "The native host returned no service.")
            return { url: response.url, password: response.password, source: "host" as const }
          },
          (error: unknown) => {
            throw new HostError(error instanceof Error ? error.message : String(error))
          },
        )
    await verify(info)
    return info
  }
  const get = () => {
    if (state.status === "ready") return Promise.resolve(state.info)
    pending ??= load().then(
      (info) => {
        pending = undefined
        set({ status: "ready", info })
        return info
      },
      (error: unknown) => {
        pending = undefined
        set({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
          hostMissing: error instanceof HostError && /not found|forbidden/i.test(error.message),
        })
        throw error
      },
    )
    return pending
  }
  return {
    state: () => state,
    get,
    refresh() {
      set({ status: "loading" })
      return get()
    },
    async manual(url: string, password: string) {
      await chrome.storage.local.set({ [MANUAL_KEY]: { url: url.replace(/\/+$/, ""), password } })
      set({ status: "loading" })
      return get()
    },
    async clearManual() {
      await chrome.storage.local.remove(MANUAL_KEY)
      set({ status: "loading" })
      return get()
    },
  }
}

export type Service = ReturnType<typeof createService>

class HostError extends Error {}

async function verify(info: ServiceInfo) {
  // /api/location exists on every V2 server and needs auth, so it checks reachability and the password together.
  const response = await fetch(`${info.url}/api/location`, {
    headers: { Authorization: `Basic ${btoa(`opencode:${info.password}`)}` },
  }).catch((error: unknown) => {
    throw new Error(`opencode is not reachable at ${info.url}: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (response.status === 401) throw new Error(`opencode at ${info.url} rejected the password.`)
  if (!response.ok) throw new Error(`opencode at ${info.url} is not ready (HTTP ${response.status}).`)
}
