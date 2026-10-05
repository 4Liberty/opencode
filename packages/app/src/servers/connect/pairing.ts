import { isUnauthorizedError, OpenCode } from "@opencode/client/promise"
import { normalizeServerUrl } from "@/runtime/server/registry"

export function serverAddress(value: string) {
  if (value.includes("://") && !/^https?:\/\//.test(value.trim())) return
  const normalized = normalizeServerUrl(value)
  if (!normalized || !URL.canParse(normalized)) return
  const url = new URL(normalized)
  if (url.protocol !== "http:" && url.protocol !== "https:") return
  if (url.username || url.password || url.search || url.hash) return
  return normalized
}

// Links printed by `opencode pair` carry a single-use code that the server exchanges for a session token.
export function pairingLink(value: string) {
  const url = URL.parse(value.trim())
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return
  const code = /^\/auth\/connect\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1]
  const address = serverAddress(url.origin)
  if (!code || !address) return
  return { url: address, code }
}

export type Pairing = { readonly url: string; readonly password: string }
export type PairingRedemption =
  | { readonly ok: true; readonly pairing: Pairing }
  | { readonly ok: false; readonly reason: "expired" | "connection" }

export function redeemPairingLink(link: { url: string; code: string }, fetch?: typeof globalThis.fetch) {
  return OpenCode.make({ baseUrl: link.url, fetch })
    .server.connect({ code: link.code })
    .then(
      (session): PairingRedemption => ({ ok: true, pairing: { url: link.url, password: session.token } }),
      (error): PairingRedemption => ({
        ok: false,
        reason: isUnauthorizedError(error) ? "expired" : "connection",
      }),
    )
}
