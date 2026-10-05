import path from "node:path"
import { pathToFileURL } from "node:url"

export type RuntimeModuleLoader = () => Record<string, unknown> | Promise<Record<string, unknown>>
export type RuntimeModuleEntry = Record<string, unknown> | RuntimeModuleLoader

export function discoverEffectSpecifiers(from = import.meta.dir): ReadonlyArray<readonly [string, string]> {
  const pkg = Bun.resolveSync("effect/package.json", from)
  const dir = path.dirname(pkg)
  const dist = path.join(dir, "dist")
  const entries: Array<readonly [string, string]> = [["effect", Bun.resolveSync("effect", dir)]]
  for (const file of new Bun.Glob("**/*.js").scanSync({ cwd: dist })) {
    const normalized = file.replaceAll("\\", "/")
    if (normalized === "index.js" || normalized.startsWith("internal/") || normalized.includes("/internal/")) continue
    const subpath = normalized.endsWith("/index.js")
      ? normalized.slice(0, -"/index.js".length)
      : normalized.slice(0, -".js".length)
    const specifier = `effect/${subpath}`
    try {
      entries.push([specifier, Bun.resolveSync(specifier, dir)])
    } catch {}
  }
  return entries.toSorted(([left], [right]) => left.localeCompare(right))
}

let cached: Readonly<Record<string, RuntimeModuleLoader>> | undefined

export function pluginRuntimeModules(): Readonly<Record<string, RuntimeModuleLoader>> {
  if (cached) return cached
  cached = {
    "@opencode/plugin": () => import("./promise/index.js"),
    "@opencode/plugin/effect": () => import("./effect/index.js"),
    "@opencode/plugin/effect/plugin": () => import("./effect/plugin.js"),
    "@opencode/plugin/effect/tool": () => import("./effect/tool.js"),
    "@opencode/plugin/promise/plugin": () => import("./promise/plugin.js"),
    "@opencode/plugin/promise/tool": () => import("./promise/tool.js"),
    "@opencode/plugin/rpc": () => import("./rpc.js"),
    ...Object.fromEntries(
      discoverEffectSpecifiers().map(([specifier, resolved]) => [
        specifier,
        () => import(pathToFileURL(resolved).href) as Promise<Record<string, unknown>>,
      ]),
    ),
  }
  return cached
}
