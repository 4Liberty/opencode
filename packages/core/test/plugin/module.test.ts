import { expect } from "bun:test"
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Brand, Deferred, Effect, Exit, Fiber, Layer, Option, Schedule, Schema, Scope, Stream } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Plugin } from "@opencode/core/plugin"
import { PluginModule } from "@opencode/core/plugin/module"
import { Rpc } from "@opencode/core/rpc"
import { Tool } from "@opencode/core/tool"
import { execute } from "@opencode/core/tool/runtime"
import { Global } from "@opencode/util/global"
import { Npm } from "@opencode/util/npm"
import { tempGlobalLayer } from "../fixture/global"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(
  Layer.mergeAll(
    PluginTestLayer,
    AppNodeBuilder.build(Npm.node, [Global.node.replace(tempGlobalLayer)]),
    Watcher.layer().pipe(Layer.provide(Watcher.nativeLayer)),
  ),
)

it.live("watches creation of an external helper with missing parent directories", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const entry = path.join(directory.path, "plugin/index.ts")
    yield* Effect.promise(() => Bun.write(entry, 'export { default } from "../shared/new/nested/helper.ts"'))
    const modules = yield* PluginModule.make()
    const operation = { type: "add" as const, target: path.dirname(entry), options: {} }
    expect(Exit.isFailure(yield* modules.load(operation).pipe(Effect.exit))).toBe(true)
    const changed = yield* modules
      .changes()
      .pipe(Stream.runHead, Effect.timeout("5 seconds"), Effect.forkScoped({ startImmediately: true }))
    yield* Effect.promise(() =>
      Bun.write(
        path.join(directory.path, "shared/new/nested/helper.ts"),
        'export default { id: "appeared", async setup() {} }',
      ),
    )
    yield* Fiber.join(changed)
    const loaded = yield* modules.load(operation)
    expect(loaded).toMatchObject({ id: "appeared" })
  }),
)

it.live("interrupts pending watcher setup when the loader scope closes during module evaluation", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const entry = path.join(directory.path, "index.ts")
    const entered = path.join(directory.path, "entered")
    const release = path.join(directory.path, "release")
    const started = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    const gate = yield* Deferred.make<void>()
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Bun.write(release, "release")).pipe(
        Effect.andThen(Deferred.succeed(gate, undefined)),
        Effect.andThen(Scope.close(scope, Exit.void)),
      ),
    )
    yield* Effect.promise(() =>
      Bun.write(
        entry,
        `
        await Bun.write(${JSON.stringify(entered)}, "entered")
        while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(5)
        export default { id: "pending", async setup() {} }
      `,
      ),
    )
    const modules = yield* PluginModule.make().pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(Watcher.Service, {
        subscribe: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
            Effect.as(Stream.never),
          ),
      }),
    )
    yield* modules.load({ type: "add", target: directory.path, options: {} }).pipe(Effect.forkIn(scope))
    yield* Deferred.await(started)
    yield* Effect.promise(() => Bun.file(entered).exists()).pipe(
      Effect.repeat({ until: (exists) => exists, schedule: Schedule.spaced("5 millis") }),
      Effect.timeout("2 seconds"),
    )
    yield* Scope.close(scope, Exit.void)
    expect(yield* Deferred.isDone(stopped)).toBe(true)
    yield* Effect.promise(() => Bun.write(release, "release"))
    // Let the uncancellable native import finish; Bun's test runner detects unhandled rejections.
    yield* Effect.promise(() => Bun.sleep(50))
  }),
)

it.live("loads plugins and their transitive dependencies against the host's Effect instance", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const pluginDir = path.join(directory.path, "plugin")
    const pluginEffectDir = path.join(pluginDir, "node_modules/effect")
    const hostEffectDir = path.dirname(Bun.resolveSync("effect/package.json", import.meta.dir))

    yield* Effect.promise(async () => {
      await mkdir(path.join(pluginDir, "node_modules"), { recursive: true })
      await cp(hostEffectDir, pluginEffectDir, { recursive: true })

      const pkgPath = path.join(pluginEffectDir, "package.json")
      const pkg = { ...(await Bun.file(pkgPath).json()), version: "4.0.0-rc.111" }
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2))

      // Reproduce the version-skew failure modes on the plugin's own Effect copy so loading it would crash:
      // 1. Effect.log reading an incompatible fiber log-level property (crashing host logger with logLevel.toUpperCase)
      // 2. Effect.runPromise calling fiber.succeedWith on a host fiber
      // 3. Schema.withDecodingDefault / Schema.Int / Schema.isPattern / Schema.Trim using foreign parser sentinels
      const internalEffectPath = path.join(pluginEffectDir, "dist/internal/effect.js")
      const internalEffect = (await readFile(internalEffectPath, "utf8"))
        .replace(
          "const logLevel = level ?? fiber.currentLogLevel;\n    if (isLogLevelGreaterThan(fiber.minimumLogLevel, logLevel)) {",
          "const logLevel = level ?? fiber.cache?.logLevel;\n    if (isLogLevelGreaterThan(fiber.cache?.minimumLogLevel, logLevel)) {",
        )
        .replace(
          "export const runPromiseWith = context => {",
          "export const runPromiseWith = context => {\n  return (effect) => Promise.resolve().then(() => { const fiber = {}; return fiber.succeedWith(effect); });",
        )
      await writeFile(internalEffectPath, internalEffect)

      const depDir = path.join(pluginDir, "node_modules/transitive-dep")
      await mkdir(depDir, { recursive: true })
      await writeFile(
        path.join(depDir, "package.json"),
        JSON.stringify({ name: "transitive-dep", type: "module", exports: { ".": "./index.js" } }),
      )
      await writeFile(
        path.join(depDir, "index.js"),
        `import { Effect as DepEffect, Schema as DepSchema } from "effect"
import { some as depSome } from "effect/Option"
export const depToolInput = DepSchema.Struct({
  mode: DepSchema.String.pipe(DepSchema.withDecodingDefault(DepEffect.succeed("from-dep"))),
})
export { DepEffect, DepSchema, depSome }`,
      )

      const foreignPluginPkgDir = path.join(pluginDir, "node_modules/@opencode/plugin")
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
        "export const Plugin = { define: (p) => p }",
      )
      await writeFile(path.join(foreignPluginPkgDir, "rpc.js"), "export const Rpc = { define: (d) => d }")

      await writeFile(
        path.join(pluginDir, "index.ts"),
        `import { Plugin } from "@opencode/plugin/effect"
import { Rpc } from "@opencode/plugin/rpc"
import { Effect as PluginEffect, Schema as PluginSchema } from "effect"
import { some as pluginSome } from "effect/Option"
import { nominal as pluginNominal } from "effect/Brand"
import { DepEffect, DepSchema, depSome, depToolInput } from "transitive-dep"

export const captured = {
  PluginEffect,
  PluginSchema,
  pluginSome,
  pluginNominal,
  DepEffect,
  DepSchema,
  depSome,
  pluginCount: -1,
}

const Contract = Rpc.define({
  id: "host-effect-rpc",
  methods: {
    check: {
      input: PluginSchema.Struct({
        count: PluginSchema.Int.pipe(PluginSchema.withDecodingDefault(PluginEffect.succeed(5))),
        tag: PluginSchema.Trim.check(PluginSchema.isPattern(/^v[0-9]+$/)),
      }),
      output: PluginSchema.Struct({
        value: PluginSchema.String,
      }),
    },
  },
  events: {},
})

export default Plugin.define({
  id: "host-effect-fixture",
  effect: (ctx) =>
    PluginEffect.gen(function* () {
      yield* PluginEffect.log("setup log from plugin")
      const listed = yield* PluginEffect.promise(() =>
        PluginEffect.runPromise(ctx.plugin.list().pipe(PluginEffect.orDie)),
      )
      captured.pluginCount = listed.data.length

      yield* ctx.tool.transform((editor) => {
        editor.add({
          name: "default_tool",
          description: "Tool with decoding default from transitive dependency",
          input: depToolInput,
          output: PluginSchema.Struct({ mode: PluginSchema.String }),
          execute: ({ mode }) =>
            PluginEffect.log("executing default_tool").pipe(
              PluginEffect.as({ output: { mode }, content: mode }),
            ),
        })
        editor.add({
          name: "check_tool",
          description: "Tool with Int, Trim, and isPattern checks",
          input: PluginSchema.Struct({
            count: PluginSchema.Int,
            code: PluginSchema.Trim.check(PluginSchema.isPattern(/^v[0-9]+$/)),
          }),
          output: PluginSchema.Struct({ formatted: PluginSchema.String }),
          execute: ({ count, code }) =>
            PluginEffect.succeed({
              output: { formatted: \`\${code}:\${count}\` },
              content: \`\${code}:\${count}\`,
            }),
        })
      })

      yield* ctx.rpc.register(Contract, {
        check: ({ count, tag }) =>
          PluginEffect.log("executing rpc check").pipe(
            PluginEffect.as({ value: \`\${tag}#\${count}\` }),
          ),
      }).pipe(PluginEffect.orDie)
    }),
})`,
      )
    })

    const modules = yield* PluginModule.make()
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const rpc = yield* Rpc.Service

    const definition = yield* modules.load({ type: "add", target: pluginDir, options: {} })
    if ("pending" in definition) return yield* Effect.die(new Error("Local plugin was not loaded"))
    yield* plugins.activate([definition])
    yield* plugins.awaitActivation

    expect(yield* plugins.list()).toMatchObject([{ id: "host-effect-fixture", state: { status: "active" } }])

    const imported = (yield* Effect.promise(() => import(path.join(pluginDir, "index.ts")))) as {
      captured: {
        PluginEffect: unknown
        PluginSchema: unknown
        pluginSome: unknown
        pluginNominal: unknown
        DepEffect: unknown
        DepSchema: unknown
        depSome: unknown
        pluginCount: number
      }
    }
    expect(imported.captured.PluginEffect).toBe(Effect)
    expect(imported.captured.PluginSchema).toBe(Schema)
    expect(imported.captured.pluginSome).toBe(Option.some)
    expect(imported.captured.pluginNominal).toBe(Brand.nominal)
    expect(imported.captured.DepEffect).toBe(Effect)
    expect(imported.captured.DepSchema).toBe(Schema)
    expect(imported.captured.depSome).toBe(Option.some)
    expect(imported.captured.pluginCount).toBe(0)

    const registeredTools = yield* tools.list()
    const defaultTool = registeredTools.find((tool) => tool.id === "default_tool")
    const checkTool = registeredTools.find((tool) => tool.id === "check_tool")
    expect(defaultTool).toBeDefined()
    expect(checkTool).toBeDefined()
    if (!defaultTool || !checkTool) return

    const context = {
      sessionID: Session.ID.make("ses_host_effect"),
      agent: Agent.ID.make("build"),
      messageID: SessionMessage.ID.make("msg_host_effect"),
      id: Tool.CallID.make("call_host_effect"),
      progress: () => Effect.void,
    }

    expect(yield* execute(defaultTool, {}, context)).toEqual({
      output: { mode: "from-dep" },
      content: [{ type: "text", text: "from-dep" }],
    })
    expect(yield* execute(checkTool, { count: 3, code: "  v42  " }, context)).toEqual({
      output: { formatted: "v42:3" },
      content: [{ type: "text", text: "v42:3" }],
    })
    expect(yield* rpc.call("host-effect-rpc", "check", { tag: " v9 " })).toEqual({ value: "v9#5" })
  }),
)

it.live("fails activation when a plugin returns an Effect from a bundled copy of effect", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const pluginDir = path.join(directory.path, "bundled-plugin")
    const bundledEffectDir = path.join(pluginDir, "bundled-effect")
    const hostEffectDir = path.dirname(Bun.resolveSync("effect/package.json", import.meta.dir))

    yield* Effect.promise(async () => {
      await mkdir(pluginDir, { recursive: true })
      await cp(hostEffectDir, bundledEffectDir, { recursive: true })
      await writeFile(
        path.join(pluginDir, "index.ts"),
        `import { Effect as BundledEffect } from "./bundled-effect/dist/index.js"
export default {
  id: "bundled-effect-plugin",
  effect: () => BundledEffect.void,
}`,
      )
    })

    const modules = yield* PluginModule.make()
    const plugins = yield* Plugin.Service

    const definition = yield* modules.load({ type: "add", target: pluginDir, options: {} })
    if ("pending" in definition) return yield* Effect.die(new Error("Local plugin was not loaded"))
    yield* plugins.activate([definition])
    yield* plugins.awaitActivation

    expect(yield* plugins.list()).toMatchObject([
      {
        id: "bundled-effect-plugin",
        state: {
          status: "failed",
          error: expect.stringContaining(
            'Plugin "bundled-effect-plugin" returned an Effect from a bundled copy of effect. Declare "effect" as a peerDependency and do not bundle it.',
          ),
        },
      },
    ])
  }),
)
