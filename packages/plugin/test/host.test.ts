import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { pathToFileURL } from "node:url"
import { Effect, Option, Schema } from "effect"
import { Brand } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Plugin, Tool } from "../src/effect/index.js"
import { Rpc } from "../src/rpc.js"
import { Host } from "../src/host.js"

// Every entrypoint throws if evaluated: resolution must never execute plugins.
const source = 'throw new Error("Plugin code must not run during resolution")'
const name = "@fixture/plugin"

async function fixture(files: Record<string, string>, installed = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-host-")))
  const directory = installed ? path.join(root, "node_modules", name) : root
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
      await writeFile(path.join(directory, file), content)
    }),
  )
  return {
    target: { directory, ...(installed ? { name } : {}) },
    url: (file: string) => pathToFileURL(path.join(directory, file)).href,
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  }
}

describe("Host.resolve", () => {
  it("resolves conventional entrypoints without package.json", async () => {
    await using plugin = await fixture({ "index.ts": source, "tui.tsx": source, "rpc.ts": source })
    assert.deepEqual(Host.resolve(plugin.target), {
      server: plugin.url("index.ts"),
      tui: plugin.url("tui.tsx"),
      rpc: plugin.url("rpc.ts"),
    })
  })

  it("resolves a TUI-only directory without an index or package.json", async () => {
    await using plugin = await fixture({ "tui.tsx": source })
    assert.deepEqual(Host.resolve(plugin.target), {
      server: undefined,
      tui: plugin.url("tui.tsx"),
      rpc: undefined,
    })
  })

  for (const main of [undefined, "lib/backend.js"]) {
    it(`resolves packages without exports using ${main ?? "the default index"}`, async () => {
      await using plugin = await fixture(
        {
          "package.json": JSON.stringify({ name, main }),
          [main ?? "index.js"]: source,
          "tui.js": source,
          "rpc.js": source,
        },
        true,
      )
      assert.deepEqual(Host.resolve(plugin.target), {
        server: plugin.url(main ?? "index.js"),
        tui: plugin.url("tui.js"),
        rpc: plugin.url("rpc.js"),
      })
    })
  }

  it("resolves local conventional entrypoints with package.json but no exports", async () => {
    await using plugin = await fixture({
      "package.json": JSON.stringify({ name, type: "module" }),
      "index.js": source,
      "tui.js": source,
      "rpc.js": source,
    })
    assert.deepEqual(Host.resolve(plugin.target), {
      server: plugin.url("index.js"),
      tui: plugin.url("tui.js"),
      rpc: plugin.url("rpc.js"),
    })
  })

  it("honors exports and prefers the explicit server entrypoint over the root", async () => {
    await using plugin = await fixture(
      {
        "package.json": JSON.stringify({
          name,
          exports: {
            ".": "./dist/root.js",
            "./server": "./dist/backend.js",
            "./tui": "./dist/terminal.js",
            "./rpc": "./dist/contract.js",
          },
        }),
        "dist/root.js": source,
        "dist/backend.js": source,
        "dist/terminal.js": source,
        "dist/contract.js": source,
      },
      true,
    )
    assert.deepEqual(Host.resolve(plugin.target), {
      server: plugin.url("dist/backend.js"),
      tui: plugin.url("dist/terminal.js"),
      rpc: plugin.url("dist/contract.js"),
    })
  })

  it("falls back to the root export and uses import rather than require conditions", async () => {
    await using plugin = await fixture(
      {
        "package.json": JSON.stringify({
          name,
          exports: {
            ".": { import: "./dist/server.mjs", require: "./dist/server.cjs" },
            "./tui": { import: "./dist/tui.mjs", require: "./dist/tui.cjs" },
          },
        }),
        "dist/server.mjs": source,
        "dist/server.cjs": source,
        "dist/tui.mjs": source,
        "dist/tui.cjs": source,
      },
      true,
    )
    assert.deepEqual(Host.resolve(plugin.target), {
      server: plugin.url("dist/server.mjs"),
      tui: plugin.url("dist/tui.mjs"),
      rpc: undefined,
    })
  })

  it("supports TUI-only exports without falling back to unexported files", async () => {
    await using plugin = await fixture(
      {
        "package.json": JSON.stringify({ name, exports: { "./tui": "./dist/terminal.js" } }),
        "dist/terminal.js": source,
        "index.js": source,
        "server.js": source,
        "rpc.js": source,
      },
      true,
    )
    assert.deepEqual(Host.resolve(plugin.target), {
      server: undefined,
      tui: plugin.url("dist/terminal.js"),
      rpc: undefined,
    })
  })

  it("does not return an exported entrypoint whose file is missing", async () => {
    await using plugin = await fixture(
      { "package.json": JSON.stringify({ name, exports: { "./tui": "./missing.js" } }) },
      true,
    )
    assert.deepEqual(Host.resolve(plugin.target), { server: undefined, tui: undefined, rpc: undefined })
  })
})

describe("Host.load", () => {
  it("resolves effect, effect/* subpaths, and @opencode/plugin/* to the host across plugin node_modules", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-host-load-")))
    try {
      const hostEffectDir = path.dirname(Bun.resolveSync("effect/package.json", import.meta.dir))
      const pluginEffectDir = path.join(root, "node_modules/effect")
      await mkdir(path.join(root, "node_modules"), { recursive: true })
      await cp(hostEffectDir, pluginEffectDir, { recursive: true })
      const manifest = { ...(await Bun.file(path.join(pluginEffectDir, "package.json")).json()), version: "4.0.0-rc.111" }
      await writeFile(path.join(pluginEffectDir, "package.json"), JSON.stringify(manifest, null, 2))

      const depDir = path.join(root, "node_modules/transitive-dep")
      await mkdir(depDir, { recursive: true })
      await writeFile(
        path.join(depDir, "package.json"),
        JSON.stringify({ name: "transitive-dep", type: "module", exports: { ".": "./index.js" } }),
      )
      await writeFile(
        path.join(depDir, "index.js"),
        `import { Effect as DepEffect, Schema as DepSchema } from "effect"
import { some as depSome } from "effect/Option"
export { DepEffect, DepSchema, depSome }`,
      )

      const foreignPluginPkgDir = path.join(root, "node_modules/@opencode/plugin")
      await mkdir(foreignPluginPkgDir, { recursive: true })
      await writeFile(
        path.join(foreignPluginPkgDir, "package.json"),
        JSON.stringify({
          name: "@opencode/plugin",
          type: "module",
          exports: { "./effect": "./effect.js", "./rpc": "./rpc.js" },
        }),
      )
      await writeFile(
        path.join(foreignPluginPkgDir, "effect.js"),
        "export const Plugin = { define: (p) => p }; export const Tool = {}",
      )
      await writeFile(path.join(foreignPluginPkgDir, "rpc.js"), "export const Rpc = { define: (d) => d }")

      await writeFile(
        path.join(root, "helper.ts"),
        `import { nominal } from "effect/Brand"
import { HttpClient as HelperHttpClient } from "effect/unstable/http"
import { DepEffect, DepSchema, depSome } from "transitive-dep"
export { nominal, HelperHttpClient, DepEffect, DepSchema, depSome }`,
      )

      const entry = path.join(root, "index.ts")
      await writeFile(
        entry,
        `import { Effect as PluginEffect, Schema as PluginSchema } from "effect"
import { some as pluginSome } from "effect/Option"
import { Plugin as PluginDef, Tool as PluginTool } from "@opencode/plugin/effect"
import { Rpc as PluginRpc } from "@opencode/plugin/rpc"
import { nominal, HelperHttpClient, DepEffect, DepSchema, depSome } from "./helper"
export { PluginEffect, PluginSchema, pluginSome, PluginDef, PluginTool, PluginRpc, nominal, HelperHttpClient, DepEffect, DepSchema, depSome }`,
      )

      const loaded = (await Host.load(pathToFileURL(entry).href)) as Record<string, unknown>
      assert.equal(loaded.PluginEffect, Effect)
      assert.equal(loaded.PluginSchema, Schema)
      assert.equal(loaded.pluginSome, Option.some)
      assert.equal(loaded.nominal, Brand.nominal)
      assert.equal(loaded.HelperHttpClient, HttpClient)
      assert.equal(loaded.PluginDef, Plugin)
      assert.equal(loaded.PluginTool, Tool)
      assert.equal(loaded.PluginRpc, Rpc)
      assert.equal(loaded.DepEffect, Effect)
      assert.equal(loaded.DepSchema, Schema)
      assert.equal(loaded.depSome, Option.some)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("resolves effect, effect/* subpaths, and @opencode/plugin/effect to the host under Node", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-host-node-")))
    try {
      const pluginDir = path.join(root, "plugin")
      await mkdir(path.join(pluginDir, "node_modules/effect"), { recursive: true })
      await writeFile(
        path.join(pluginDir, "node_modules/effect/package.json"),
        JSON.stringify({
          name: "effect",
          version: "4.0.0-rc.111",
          type: "module",
          exports: { ".": "./index.js", "./Option": "./Option.js" },
        }),
      )
      await writeFile(path.join(pluginDir, "node_modules/effect/index.js"), "export const Effect = { foreign: true }")
      await writeFile(path.join(pluginDir, "node_modules/effect/Option.js"), "export const some = () => null")

      await mkdir(path.join(pluginDir, "node_modules/transitive-dep"), { recursive: true })
      await writeFile(
        path.join(pluginDir, "node_modules/transitive-dep/package.json"),
        JSON.stringify({ name: "transitive-dep", type: "module", exports: { ".": "./index.js" } }),
      )
      await writeFile(
        path.join(pluginDir, "node_modules/transitive-dep/index.js"),
        'import { Effect as DepEffect } from "effect"; import { some as depSome } from "effect/Option"; export { DepEffect, depSome }',
      )

      await mkdir(path.join(pluginDir, "node_modules/@opencode/plugin"), { recursive: true })
      await writeFile(
        path.join(pluginDir, "node_modules/@opencode/plugin/package.json"),
        JSON.stringify({ name: "@opencode/plugin", type: "module", exports: { "./effect": "./effect.js" } }),
      )
      await writeFile(
        path.join(pluginDir, "node_modules/@opencode/plugin/effect.js"),
        "export const Plugin = { define: (p) => p }",
      )

      const entry = path.join(pluginDir, "index.mjs")
      await writeFile(
        entry,
        `import { Effect as PluginEffect, Schema as PluginSchema } from "effect"
import { some as pluginSome } from "effect/Option"
import { Plugin as PluginDef } from "@opencode/plugin/effect"
import { DepEffect, depSome } from "transitive-dep"
export { PluginEffect, PluginSchema, pluginSome, PluginDef, DepEffect, depSome }`,
      )

      const script = path.join(root, "probe.ts")
      await writeFile(
        script,
        `import assert from "node:assert/strict"
import { Effect, Option, Schema } from ${JSON.stringify(Bun.resolveSync("effect", import.meta.dir))}
import { Plugin } from ${JSON.stringify(path.join(import.meta.dir, "../src/effect/index.ts"))}
import { Host } from ${JSON.stringify(path.join(import.meta.dir, "../src/host.ts"))}
const loaded = await Host.load(${JSON.stringify(pathToFileURL(entry).href)}) as Record<string, unknown>
assert.equal(loaded.PluginEffect, Effect)
assert.equal(loaded.PluginSchema, Schema)
assert.equal(loaded.pluginSome, Option.some)
assert.equal(loaded.PluginDef, Plugin)
assert.equal(loaded.DepEffect, Effect)
assert.equal(loaded.depSome, Option.some)
console.log("node host load passed")`,
      )

      const build = await Bun.build({
        entrypoints: [script],
        target: "node",
        format: "esm",
        outdir: root,
        naming: "probe.mjs",
      })
      assert.equal(build.success, true)
      const child = Bun.spawn(["node", "--no-warnings", path.join(root, "probe.mjs")], {
        cwd: path.join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      assert.deepEqual({ stdout, stderr, exit }, { stdout: "node host load passed\n", stderr: "", exit: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
