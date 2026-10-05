import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { plugin, type PluginBuilder } from "bun"
import { pluginRuntimeModules, type RuntimeModuleEntry } from "./runtime-modules.bun.js"

export { pluginRuntimeModules } from "./runtime-modules.bun.js"

const RUNTIME_MODULE_PREFIX = "opentui:runtime-module:"
const opentuiInstalledKey = Symbol.for("opentui.solid.runtime-plugin-support")
const solidTransformKey = Symbol.for("opentui.solid.transform")
const pluginRuntimeStateKey = Symbol.for("opencode.plugin.runtime-plugin-support")

type RuntimeState = {
  readonly prepare: (entrypoint?: string) => void
}

type GlobalState = typeof globalThis & {
  [opentuiInstalledKey]?: { readonly specifiers?: ReadonlySet<string> }
  [solidTransformKey]?: { readonly installed?: boolean }
  [pluginRuntimeStateKey]?: RuntimeState
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const runtimeModuleIdForSpecifier = (specifier: string) => `${RUNTIME_MODULE_PREFIX}${encodeURIComponent(specifier)}`

const sourcePath = (value: string) => {
  const search = value.indexOf("?")
  const hash = value.indexOf("#")
  const end = [search, hash].filter((index) => index >= 0).sort((a, b) => a - b)[0]
  return end === undefined ? value : value.slice(0, end)
}

const normalizedPaths = new Map<string, string>()

const normalizeSourcePath = (value: string) => {
  const clean = sourcePath(value)
  const cached = normalizedPaths.get(clean)
  if (cached !== undefined) return cached
  const normalized = (() => {
    try {
      return realpathSync(clean)
    } catch {
      return clean
    }
  })()
  normalizedPaths.set(clean, normalized)
  return normalized
}

const exactPathFilter = (paths: readonly string[]) => {
  const candidates = [...new Set(paths.map(sourcePath))]
  return new RegExp(`^(?:${candidates.map(escapeRegExp).join("|")})(?:[?#].*)?$`)
}

const isNodeModulesPath = (value: string) => /(?:^|[/\\])node_modules(?:[/\\])/.test(value)

const runtimeLoaderForPath = (value: string) => {
  const clean = sourcePath(value)
  if (clean.endsWith(".tsx")) return "tsx" as const
  if (clean.endsWith(".jsx")) return "jsx" as const
  if (clean.endsWith(".ts") || clean.endsWith(".mts") || clean.endsWith(".cts")) return "ts" as const
  if (clean.endsWith(".js") || clean.endsWith(".mjs") || clean.endsWith(".cjs")) return "js" as const
  return null
}

const resolveImportSpecifierPatterns = [
  /(\bfrom\s*["'])([^"']+)(["'])/g,
  /(\bimport\s*["'])([^"']+)(["'])/g,
  /(\bimport\s*\(\s*["'])([^"']+)(["']\s*\))/g,
  /(\brequire\s*\(\s*["'])([^"']+)(["']\s*\))/g,
]

const isImportLikeMatchInsideQuotes = (code: string, offset: number) => {
  const previous = code[offset - 1]
  return previous === '"' || previous === "'" || previous === "`"
}

const collectImportSpecifiers = (code: string) => {
  const specifiers = new Set<string>()
  for (const pattern of resolveImportSpecifierPatterns) {
    code.replace(pattern, (full, _prefix, specifier: string, _suffix, offset: number) => {
      if (!isImportLikeMatchInsideQuotes(code, offset)) specifiers.add(specifier)
      return full
    })
  }
  return [...specifiers]
}

const resolveSourcePathFromSpecifier = (specifier: string, importer?: string) => {
  if (
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:") ||
    specifier.startsWith("http:") ||
    specifier.startsWith("https:") ||
    specifier.startsWith("data:") ||
    specifier.startsWith(RUNTIME_MODULE_PREFIX)
  )
    return null
  const candidate = specifier.startsWith("file:") ? sourcePath(fileURLToPath(specifier)) : sourcePath(specifier)
  if (isAbsolute(candidate) && existsSync(candidate) && runtimeLoaderForPath(candidate)) return candidate
  const baseDir = importer
    ? dirname(importer.startsWith("file:") ? fileURLToPath(importer) : sourcePath(importer))
    : process.cwd()
  try {
    const resolved = Bun.resolveSync(candidate, baseDir)
    if (resolved.startsWith("node:") || resolved.startsWith("bun:")) return null
    return sourcePath(resolved)
  } catch {
    return null
  }
}

export function ensurePluginRuntime(entrypoint?: string) {
  const state = globalThis as GlobalState
  if (state[opentuiInstalledKey]) return
  if (!state[pluginRuntimeStateKey]) {
    state[pluginRuntimeStateKey] = install(state)
  }
  state[pluginRuntimeStateKey].prepare(entrypoint)
}

function install(state: GlobalState): RuntimeState {
  const modules: Readonly<Record<string, RuntimeModuleEntry>> = pluginRuntimeModules()
  const runtimeModuleIds = new Map<string, string>()
  for (const specifier of Object.keys(modules)) {
    runtimeModuleIds.set(specifier, runtimeModuleIdForSpecifier(specifier))
  }

  const resolveRuntimeId = (specifier: string) => {
    const known = runtimeModuleIds.get(specifier)
    if (known) return known
    if (
      specifier === "@opentui/core" ||
      specifier === "@opentui/core/testing" ||
      state[opentuiInstalledKey]?.specifiers?.has(specifier)
    )
      return runtimeModuleIdForSpecifier(specifier)
    return undefined
  }

  const isSolidTransformActiveFor = (file: string) =>
    Boolean(state[solidTransformKey]?.installed) && /\.[cm]?[jt]sx$/.test(sourcePath(file))

  const installedLoaders = new Set<string>()
  const packageTypes = new Map<string, "module" | "commonjs">()
  const nodeModulesAnalysis = new Map<
    string,
    { readonly importSpecifiers: readonly string[]; readonly needsRewrite: boolean; readonly isEsm: boolean }
  >()
  const nodeModulesRewritePaths = new Map<string, readonly string[]>()
  let activeBuild: PluginBuilder | undefined

  const packageTypeForPath = (file: string) => {
    let current = dirname(file)
    while (true) {
      const pkgJson = join(current, "package.json")
      if (existsSync(pkgJson)) {
        const cached = packageTypes.get(pkgJson)
        if (cached) return cached
        const type = (() => {
          try {
            return JSON.parse(readFileSync(pkgJson, "utf8")).type === "module"
              ? ("module" as const)
              : ("commonjs" as const)
          } catch {
            return "commonjs" as const
          }
        })()
        packageTypes.set(pkgJson, type)
        return type
      }
      const parent = dirname(current)
      if (parent === current) return "commonjs"
      current = parent
    }
  }

  const analyzeFile = (file: string, cacheable: boolean) => {
    const normalized = normalizeSourcePath(file)
    if (cacheable) {
      const cached = nodeModulesAnalysis.get(normalized)
      if (cached) return cached
    }
    const contents = (() => {
      try {
        return readFileSync(normalized, "utf8")
      } catch {
        return undefined
      }
    })()
    if (contents === undefined) return { importSpecifiers: [], needsRewrite: false, isEsm: false }
    const importSpecifiers = collectImportSpecifiers(contents)
    const analysis = {
      importSpecifiers,
      needsRewrite: importSpecifiers.some((specifier) => resolveRuntimeId(specifier) !== undefined),
      isEsm: /\b(?:import|export)\b/.test(contents),
    }
    if (cacheable) nodeModulesAnalysis.set(normalized, analysis)
    return analysis
  }

  const isNodeModulesEsm = (file: string) => {
    const normalized = normalizeSourcePath(file)
    if (!isNodeModulesPath(normalized)) return false
    if (/\.(?:mjs|mts|ts|tsx|jsx)$/.test(normalized)) return true
    if (/\.(?:cjs|cts)$/.test(normalized) || !normalized.endsWith(".js")) return false
    return packageTypeForPath(normalized) === "module" || analyzeFile(normalized, true).isEsm
  }

  const collectNodeModulesRewrites = (file: string, visiting = new Set<string>()): readonly string[] => {
    const normalized = normalizeSourcePath(file)
    if (!isNodeModulesEsm(normalized)) return []
    const cached = nodeModulesRewritePaths.get(normalized)
    if (cached) return cached
    if (visiting.has(normalized)) return []
    visiting.add(normalized)
    const rewrites = new Set<string>()
    const analysis = analyzeFile(normalized, true)
    if (analysis.needsRewrite) rewrites.add(normalized)
    for (const specifier of analysis.importSpecifiers) {
      if (resolveRuntimeId(specifier) !== undefined) continue
      const resolved = resolveSourcePathFromSpecifier(specifier, normalized)
      if (!resolved || !isNodeModulesEsm(resolved)) continue
      for (const nested of collectNodeModulesRewrites(resolved, visiting)) rewrites.add(nested)
    }
    visiting.delete(normalized)
    const result = [...rewrites]
    nodeModulesRewritePaths.set(normalized, result)
    return result
  }

  const installRewriteLoader = (file: string) => {
    if (!activeBuild) return
    const resolvedTarget = sourcePath(file)
    if (!isNodeModulesPath(resolvedTarget) && isSolidTransformActiveFor(resolvedTarget)) return
    const canonicalTarget = normalizeSourcePath(resolvedTarget)
    if (installedLoaders.has(canonicalTarget)) return
    installedLoaders.add(canonicalTarget)
    const build = activeBuild
    build.onLoad({ filter: exactPathFilter([resolvedTarget, canonicalTarget]) }, (args) => {
      const loaded = normalizeSourcePath(args.path)
      if (loaded !== canonicalTarget) return undefined as never
      const loader = runtimeLoaderForPath(args.path)
      if (!loader) throw new Error(`Unable to determine runtime loader for path: ${args.path}`)
      let code = readFileSync(loaded, "utf8")
      for (const pattern of resolveImportSpecifierPatterns) {
        code = code.replace(pattern, (full, prefix: string, specifier: string, suffix: string, offset: number) => {
          if (isImportLikeMatchInsideQuotes(code, offset)) return full
          const replacement = resolveRuntimeId(specifier)
          return replacement ? `${prefix}${replacement}${suffix}` : full
        })
      }
      return { contents: code, loader }
    })
  }

  const prescanGraph = (entryFile: string, visiting = new Set<string>()) => {
    const normalized = normalizeSourcePath(entryFile)
    if (visiting.has(normalized)) return
    visiting.add(normalized)
    const analysis = analyzeFile(normalized, false)
    if (analysis.needsRewrite) installRewriteLoader(entryFile)
    for (const specifier of analysis.importSpecifiers) {
      if (resolveRuntimeId(specifier) !== undefined) continue
      const resolved = resolveSourcePathFromSpecifier(specifier, normalized)
      if (!resolved || !runtimeLoaderForPath(resolved)) continue
      if (isNodeModulesPath(resolved)) {
        for (const rewrite of collectNodeModulesRewrites(resolved)) installRewriteLoader(rewrite)
        continue
      }
      prescanGraph(resolved, visiting)
    }
  }

  plugin({
    name: "opencode-plugin-runtime-modules",
    setup(build) {
      activeBuild = build
      if (!state[opentuiInstalledKey]) {
        for (const [specifier, entry] of Object.entries(modules)) {
          const moduleId = runtimeModuleIds.get(specifier)
          if (!moduleId) continue
          build.module(moduleId, async () => ({
            exports: typeof entry === "function" ? await entry() : entry,
            loader: "object",
          }))
        }
      }
      build.onResolve({ filter: /^(?:effect(?:\/|$)|@opencode\/plugin(?:\/|$))/ }, (args) => {
        const direct = resolveRuntimeId(args.path)
        return direct ? { path: direct } : undefined
      })
    },
  })

  return {
    prepare(entrypoint?: string) {
      if (!entrypoint) return
      const resolved = resolveSourcePathFromSpecifier(entrypoint)
      if (!resolved || !runtimeLoaderForPath(resolved)) return
      prescanGraph(resolved)
    },
  }
}
