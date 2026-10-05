import { createRequire, registerHooks } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

const PREFIX = "opencode:runtime-module:"
const modulesKey = Symbol.for("opencode.plugin.runtime.modules")

type GlobalState = typeof globalThis & {
  [modulesKey]?: Map<string, Record<string, unknown>>
}

let pending: Promise<void> | undefined

export function ensurePluginRuntime(_entrypoint?: string): Promise<void> {
  if (pending) return pending
  pending = setup()
  return pending
}

async function setup() {
  const state = globalThis as GlobalState
  if (state[modulesKey]) return

  const [effect, promiseIndex, promisePlugin, promiseTool, effectIndex, effectPlugin, effectTool, rpc] =
    await Promise.all([
      import("effect") as Promise<Record<string, unknown>>,
      import("./promise/index.js") as Promise<Record<string, unknown>>,
      import("./promise/plugin.js") as Promise<Record<string, unknown>>,
      import("./promise/tool.js") as Promise<Record<string, unknown>>,
      import("./effect/index.js") as Promise<Record<string, unknown>>,
      import("./effect/plugin.js") as Promise<Record<string, unknown>>,
      import("./effect/tool.js") as Promise<Record<string, unknown>>,
      import("./rpc.js") as Promise<Record<string, unknown>>,
    ])

  const modules = new Map<string, Record<string, unknown>>([
    ["effect", effect],
    ["@opencode/plugin", promiseIndex],
    ["@opencode/plugin/promise/plugin", promisePlugin],
    ["@opencode/plugin/promise/tool", promiseTool],
    ["@opencode/plugin/effect", effectIndex],
    ["@opencode/plugin/effect/plugin", effectPlugin],
    ["@opencode/plugin/effect/tool", effectTool],
    ["@opencode/plugin/rpc", rpc],
  ])

  for (const [key, value] of Object.entries(effect)) {
    if (typeof value === "object" && value !== null) {
      modules.set(`effect/${key}`, value as Record<string, unknown>)
    }
  }

  state[modulesKey] = modules

  const loadEffectSubpath = (specifier: string) => {
    const existing = modules.get(specifier)
    if (existing) return existing
    for (const base of [import.meta.url, pathToFileURL(path.join(process.cwd(), "package.json")).href]) {
      try {
        const loaded = createRequire(base)(specifier) as Record<string, unknown>
        if (typeof loaded === "object" && loaded !== null) {
          modules.set(specifier, loaded)
          return loaded
        }
      } catch {}
    }
    return undefined
  }

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (modules.has(specifier) || (specifier.startsWith("effect/") && loadEffectSubpath(specifier) !== undefined)) {
        return { url: `${PREFIX}${encodeURIComponent(specifier)}`, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url.startsWith(PREFIX)) {
        const specifier = decodeURIComponent(url.slice(PREFIX.length))
        const exports = modules.get(specifier)
        if (exports) {
          return { format: "module", source: createModuleSource(specifier, exports), shortCircuit: true }
        }
      }
      return nextLoad(url, context)
    },
  })
}

function createModuleSource(specifier: string, exports: Record<string, unknown>) {
  const keys = Object.keys(exports).filter((key) => key !== "default" && /^[A-Za-z_$][\w$]*$/.test(key))
  const lines = [
    `const mod = globalThis[Symbol.for("opencode.plugin.runtime.modules")].get(${JSON.stringify(specifier)})`,
    ...keys.map((key, index) => `const e${index} = mod[${JSON.stringify(key)}]`),
    ...(keys.length > 0 ? [`export { ${keys.map((key, index) => `e${index} as ${key}`).join(", ")} }`] : []),
  ]
  if ("default" in exports) lines.push("export default mod.default")
  return lines.join("\n")
}
