// Persists site scripts and keeps chrome.userScripts registrations in step with them. Chrome keeps
// registrations across restarts; the stored list is the source of truth and is reconciled on startup.
import {
  resolveDraft,
  type SiteScript,
  type SiteScriptApproval,
  type SiteScriptDraft,
  type SiteScriptsState,
} from "../shared/site-script"

const STORAGE_KEY = "siteScripts"

export type SiteScripts = ReturnType<typeof createSiteScripts>

export function createSiteScripts(changed: (state: SiteScriptsState) => void) {
  let scripts: SiteScript[] = []
  let available = false
  let error: string | undefined
  const loaded = (async () => {
    scripts = ((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] ?? []) as SiteScript[]
    await reconcile()
  })()

  const state = (): SiteScriptsState => ({ available, ...(error ? { error } : {}), scripts })
  const save = async () => {
    await chrome.storage.local.set({ [STORAGE_KEY]: scripts })
    changed(state())
  }

  /** chrome.userScripts, recording whether the user has allowed it so the panel can say how to. */
  async function api() {
    const result = await userScripts().catch((cause: unknown) => {
      const wasAvailable = available
      available = false
      error = cause instanceof Error ? cause.message : String(cause)
      if (wasAvailable) changed(state())
      throw cause
    })
    if (!available) {
      available = true
      error = undefined
      changed(state())
    }
    return result
  }

  async function reconcile() {
    const scripting = await api().catch(() => undefined)
    if (!scripting) return changed(state())
    const registered = new Set((await scripting.getScripts()).map((script) => script.id))
    const wanted = scripts.filter((script) => script.enabled)
    const stale = Array.from(registered).filter((id) => !wanted.some((script) => script.id === id))
    if (stale.length) await scripting.unregister({ ids: stale })
    await Promise.all(
      wanted.map((script) =>
        registered.has(script.id)
          ? scripting.update([registration(script)])
          : scripting.register([registration(script)]),
      ),
    )
    changed(state())
  }

  /** Installs or replaces a script. A script with the same name and matches is replaced, not duplicated. */
  async function install(draft: SiteScriptDraft) {
    await loaded
    const scripting = await api()
    const resolved = resolveDraft(draft).script
    const existing =
      (draft.id ? scripts.find((script) => script.id === draft.id) : undefined) ??
      scripts.find((script) => script.name === resolved.name && sameMatches(script.matches, resolved.matches))
    const now = Date.now()
    const script: SiteScript = {
      ...resolved,
      id: existing?.id ?? draft.id ?? `script_${crypto.randomUUID()}`,
      enabled: true,
      created: existing?.created ?? now,
      updated: now,
    }
    // Chrome validates the match patterns and code here; a rejected script is never stored.
    await (existing?.enabled ? scripting.update([registration(script)]) : scripting.register([registration(script)]))
    scripts = existing ? scripts.map((item) => (item.id === existing.id ? script : item)) : [...scripts, script]
    await save()
    return script
  }

  return {
    loaded,
    state,
    reconcile,
    install,
    /** What an install would do, for the user to approve. Throws if the draft is invalid. */
    async preview(draft: SiteScriptDraft, id: string): Promise<SiteScriptApproval> {
      await loaded
      const resolved = resolveDraft(draft)
      const replaces =
        (draft.id ? scripts.find((script) => script.id === draft.id) : undefined) ??
        scripts.find((script) => script.name === resolved.script.name && sameMatches(script.matches, resolved.script.matches))
      return {
        id,
        script: resolved.script,
        warnings: resolved.warnings,
        ...(replaces ? { replaces: { id: replaces.id, name: replaces.name } } : {}),
      }
    },
    async list() {
      await loaded
      return scripts
    },
    async get(id: string) {
      await loaded
      return find(id)
    },
    async setEnabled(id: string, enabled: boolean) {
      await loaded
      const script = find(id)
      if (script.enabled === enabled) return script
      const scripting = await api()
      if (enabled) await scripting.register([registration(script)])
      if (!enabled) await scripting.unregister({ ids: [id] })
      const next = { ...script, enabled, updated: Date.now() }
      scripts = scripts.map((item) => (item.id === id ? next : item))
      await save()
      return next
    },
    async remove(id: string) {
      await loaded
      const script = find(id)
      if (script.enabled) await (await api()).unregister({ ids: [id] }).catch(() => undefined)
      scripts = scripts.filter((item) => item.id !== id)
      await save()
      return script
    },
  }

  function find(id: string) {
    const script = scripts.find((item) => item.id === id)
    if (!script) throw new Error(`No site script with id ${id}. List the installed scripts to find the right id.`)
    return script
  }
}

/** chrome.userScripts, or an error explaining how to turn it on. */
async function userScripts() {
  const unavailable = new Error(
    'Site scripts are turned off. Open the browser\'s extensions page, choose Details on Open Extension, and turn on "Allow user scripts".',
  )
  const api = chrome.userScripts
  if (!api) throw unavailable
  // Calling any method throws while the user has not allowed user scripts for this extension.
  await api.getScripts({ ids: [] }).catch(() => {
    throw unavailable
  })
  return api
}

function registration(script: SiteScript): chrome.userScripts.RegisteredUserScript {
  return {
    id: script.id,
    matches: script.matches,
    ...(script.excludeMatches?.length ? { excludeMatches: script.excludeMatches } : {}),
    js: [{ code: script.code }],
    runAt: script.runAt,
    // Isolated by default: page DOM and storage, but not the page's own JavaScript globals.
    world: script.world === "page" ? "MAIN" : "USER_SCRIPT",
  }
}

function sameMatches(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((pattern) => b.includes(pattern))
}
