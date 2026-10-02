// Site scripts: JavaScript that Open Extension injects into matching pages with chrome.userScripts,
// the API Tampermonkey and Violentmonkey use under Manifest V3. Shared by the background worker,
// the side panel, and (as plain JSON) the opencode plugin that lets agents install them.

export type RunAt = "document_start" | "document_end" | "document_idle"

export type SiteScript = {
  id: string
  name: string
  description?: string
  /** Chrome match patterns, for example `https://x.com/*`. */
  matches: string[]
  excludeMatches?: string[]
  runAt: RunAt
  code: string
  enabled: boolean
  created: number
  updated: number
  /** The opencode session that installed it, when an agent did. */
  sessionID?: string
}

/** What an install needs; the rest is filled in from the userscript header or defaults. */
export type SiteScriptDraft = {
  id?: string
  name?: string
  description?: string
  matches?: string[]
  excludeMatches?: string[]
  runAt?: RunAt
  code: string
  sessionID?: string
}

export type SiteScriptsState = {
  /** False until the user turns on "Allow user scripts" for the extension. */
  available: boolean
  error?: string
  scripts: SiteScript[]
}

/** An agent's request to install or replace a script, waiting for the user in the side panel. */
export type SiteScriptApproval = {
  id: string
  script: Required<Pick<SiteScript, "name" | "matches" | "runAt" | "code">> &
    Pick<SiteScript, "description" | "excludeMatches" | "sessionID">
  /** The installed script this would replace. */
  replaces?: Pick<SiteScript, "id" | "name">
  warnings: string[]
}

const runAts: readonly RunAt[] = ["document_start", "document_end", "document_idle"]

/** Reads a `// ==UserScript==` header. Unsupported keys come back as warnings, not errors. */
export function parseHeader(code: string) {
  const block = code.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/)
  if (!block) return undefined
  const entries = Array.from(block[1].matchAll(/^\s*\/\/\s*@([\w:-]+)(?:[ \t]+(.*?))?\s*$/gm), (match) => ({
    key: match[1],
    value: (match[2] ?? "").trim(),
  }))
  const values = (key: string) => entries.filter((entry) => entry.key === key && entry.value).map((entry) => entry.value)
  const runAt = values("run-at")[0]?.replace(/-/g, "_")
  const grants = values("grant").filter((grant) => grant !== "none")
  return {
    name: values("name")[0],
    description: values("description")[0],
    matches: values("match"),
    excludeMatches: values("exclude-match"),
    runAt: runAts.find((item) => item === runAt),
    warnings: [
      ...(grants.length ? [`Ignored @grant ${grants.join(", ")}: GM_* APIs are not available.`] : []),
      ...(values("include").length || values("exclude").length
        ? ["Ignored @include/@exclude: use @match and @exclude-match patterns."]
        : []),
      ...(values("require").length ? ["Ignored @require: inline the code instead."] : []),
    ],
  }
}

/** Merges explicit fields with the header; explicit fields win. Throws when nothing says where it runs. */
export function resolveDraft(draft: SiteScriptDraft) {
  const header = parseHeader(draft.code)
  const matches = draft.matches?.length ? draft.matches : (header?.matches ?? [])
  if (!matches.length)
    throw new Error("A site script needs at least one match pattern, for example https://x.com/*.")
  const name = (draft.name || header?.name || hostLabel(matches[0])).slice(0, 200)
  const excludeMatches = draft.excludeMatches?.length ? draft.excludeMatches : header?.excludeMatches
  const description = draft.description || header?.description
  return {
    script: {
      name,
      matches,
      runAt: draft.runAt ?? header?.runAt ?? "document_idle",
      code: draft.code,
      ...(description ? { description } : {}),
      ...(excludeMatches?.length ? { excludeMatches } : {}),
      ...(draft.sessionID ? { sessionID: draft.sessionID } : {}),
    },
    warnings: header?.warnings ?? [],
  }
}

/** A readable site label for a match pattern: `https://x.com/*` → `x.com`. */
export function hostLabel(pattern: string) {
  const host = pattern.match(/^[a-z*]+:\/\/([^/]+)/i)?.[1]
  if (!host) return pattern
  return host === "*" ? "all sites" : host.replace(/^\*\./, "")
}
