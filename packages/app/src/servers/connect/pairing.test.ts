import { describe, expect, test } from "bun:test"
import { pairingLink, redeemPairingLink } from "./pairing"

const mockFetch = (run: () => Promise<Response>) => run as unknown as typeof globalThis.fetch

describe("pairing link", () => {
  test("reads the server address and code from opencode pair links", () => {
    expect(pairingLink(" http://192.168.1.2:49374/auth/connect/abc_DEF-123 ")).toEqual({
      url: "http://192.168.1.2:49374",
      code: "abc_DEF-123",
    })
  })

  test("rejects other URLs", () => {
    expect(pairingLink("http://192.168.1.2:49374/auth/connect/")).toBeUndefined()
    expect(pairingLink("http://192.168.1.2:49374/auth/connect/abc/extra")).toBeUndefined()
    expect(pairingLink("http://192.168.1.2:49374/connect#abc")).toBeUndefined()
    expect(pairingLink("opencode-ios://auth/connect/abc")).toBeUndefined()
    expect(pairingLink("192.168.1.2:49374")).toBeUndefined()
  })
})

describe("pairing redemption", () => {
  test("returns the session token from a successful redemption", async () => {
    const result = await redeemPairingLink(
      { url: "https://server.example", code: "fresh" },
      mockFetch(() => Promise.resolve(Response.json({ token: "session-token" }))),
    )

    expect(result).toEqual({
      ok: true,
      pairing: { url: "https://server.example", password: "session-token" },
    })
  })

  test("reports only an unauthorized response as expired", async () => {
    const result = await redeemPairingLink(
      { url: "https://server.example", code: "used" },
      mockFetch(() =>
        Promise.resolve(
          Response.json(
            { _tag: "UnauthorizedError", message: "Pairing link expired or already used" },
            { status: 401 },
          ),
        ),
      ),
    )

    expect(result).toEqual({ ok: false, reason: "expired" })
  })

  test("reports transport failures as connection errors", async () => {
    const result = await redeemPairingLink(
      { url: "https://server.example", code: "fresh" },
      mockFetch(() => Promise.reject(new TypeError("Failed to fetch"))),
    )

    expect(result).toEqual({ ok: false, reason: "connection" })
  })
})
