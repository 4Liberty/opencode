import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Config } from "@opencode/schema/config"
import { Effect, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"
import { AbsolutePath } from "@opencode/schema/schema"

it.live("returns ordered config entries for the requested directory", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-endpoint-")))
    const global = path.join(tmp.path, "global")
    const project = path.join(tmp.path, "project")
    const config = path.join(project, "opencode.json")
    yield* Effect.promise(() =>
      Promise.all([fs.mkdir(global, { recursive: true }), fs.mkdir(project, { recursive: true })]),
    )
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        JSON.stringify({
          permissions: [
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "git status", effect: "allow" },
          ],
          mcp: { servers: { docs: { type: "remote", url: "https://example.com/mcp" } } },
        }),
      ),
    )
    const server = yield* startServer(global)
    const url = new URL("/api/config", server.base)
    url.searchParams.set("location[directory]", project)
    const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
    const body: unknown = yield* Effect.promise(() => response.json())
    const entries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(body)

    expect(response.status).toBe(200)
    expect(Array.isArray(entries)).toBe(true)
    const document = entries.find(
      (entry): entry is Config.Document => entry.type === "document" && entry.path === config,
    )
    expect(document?.info.permissions).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
    ])
    expect(document?.path).toBe(AbsolutePath.make(config))
    if (!Array.isArray(body)) throw new Error("Expected a config entry array")
    const raw = body.find((entry) => isRecord(entry) && entry["type"] === "document" && entry["path"] === config)
    if (!isRecord(raw) || !isRecord(raw["info"])) throw new Error("Expected a config document")
    expect(raw["info"]).not.toHaveProperty("default_agent")
    expect(raw["info"]).not.toHaveProperty("model")
    const mcp = raw["info"]["mcp"]
    if (!isRecord(mcp) || !isRecord(mcp["servers"]) || !isRecord(mcp["servers"]["docs"]))
      throw new Error("Expected an MCP server config")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("headers")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("oauth")
  }),
)

it.live("updates supported global fields without replacing unrelated JSONC", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-shells-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        `{
  // keep this comment
  "model": "provider/model",
  "shell": "bash",
  "providers": { "existing": { "name": "Existing" } }
}
`,
      ),
    )
    const server = yield* startServer(global)
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json", "x-opencode-directory": global },
        body: JSON.stringify({ shell: "/bin/zsh" }),
      }),
    )

    expect({ status: response.status, body: yield* Effect.promise(() => response.text()) }).toEqual({
      status: 204,
      body: "",
    })
    const text = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(text).toContain("// keep this comment")
    expect(text).toContain('"model": "provider/model"')
    expect(text).toContain('"shell": "/bin/zsh"')

    const provider = {
      name: "Custom Provider",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "http://127.0.0.1:1/v1" },
      models: { demo: { name: "Demo" } },
    }
    const added = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json", "x-opencode-directory": global },
        body: JSON.stringify({ providers: { custom: provider } }),
      }),
    )
    expect(added.status).toBe(204)
    const updated = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(updated).toContain("// keep this comment")
    expect(JSON.parse(updated.replace("// keep this comment", ""))).toMatchObject({
      model: "provider/model",
      shell: "/bin/zsh",
      providers: { existing: { name: "Existing" }, custom: provider },
    })
    const loaded = yield* Effect.promise(() =>
      fetch(new URL("/api/config", server.base), {
        headers: { ...server.headers, "x-opencode-directory": global },
      }).then((response) => response.json()),
    )
    expect(Schema.decodeUnknownSync(Schema.Array(Config.Entry))(loaded)).toContainEqual(
      expect.objectContaining({
        info: expect.objectContaining({ providers: expect.objectContaining({ custom: provider }) }),
      }),
    )
    const credential = yield* Effect.promise(() =>
      fetch(new URL("/api/credential", server.base), {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ integrationID: "custom", value: { type: "key", key: "test-key" } }),
      }),
    )
    expect(credential.ok).toBe(true)
    const integrations = yield* Effect.promise(() =>
      fetch(new URL("/api/integration", server.base), {
        headers: { ...server.headers, "x-opencode-directory": global },
      }).then((response) => response.json()),
    )
    expect(integrations.data).toContainEqual(expect.objectContaining({ id: "custom" }))
    const available = yield* Effect.promise(() =>
      fetch(new URL("/api/provider", server.base), {
        headers: { ...server.headers, "x-opencode-directory": global },
      }).then((response) => response.json()),
    )
    expect(available.data).toContainEqual(expect.objectContaining({ id: "custom", name: "Custom Provider" }))

    const removed = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json", "x-opencode-directory": global },
        body: JSON.stringify({ providers: { custom: null } }),
      }),
    )
    expect(removed.status).toBe(204)
    const remaining = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(JSON.parse(remaining.replace("// keep this comment", "")).providers).toEqual({
      existing: { name: "Existing" },
    })

    const shells = yield* Effect.promise(() =>
      fetch(new URL("/api/config/shell", server.base), { headers: server.headers }),
    )
    expect(shells.status).toBe(200)
    expect(Array.isArray(yield* Effect.promise(() => shells.json()))).toBe(true)
  }),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
