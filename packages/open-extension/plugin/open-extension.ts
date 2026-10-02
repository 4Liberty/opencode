// opencode plugin for Open Extension: gives agents site_scripts tools that install JavaScript into
// matching pages of the user's browser, the way Tampermonkey does, without a separate extension.
// The extension stores the scripts and asks the user to approve every install in its side panel.
// `bun run host:install` bundles this file into ~/.config/opencode/plugins/open-extension.js.
import type { Plugin } from "@opencode/plugin"
import { ScriptsDefinition, type ScriptsCommand, type ScriptsControl, type ScriptsOutcome } from "../src/shared/scripts-rpc"

// The extension fetches a command within moments when its side panel is open; installs then wait for
// the user, so the whole request gets much longer.
const FETCH_TIMEOUT_MS = 8_000
const RESULT_TIMEOUT_MS = 10 * 60_000

const notConnected =
  "Open Extension did not respond. Ask the user to open the Open Extension side panel in their browser (it relays site script requests), then retry."

const patterns = {
  type: "array",
  items: { type: "string" },
  description: "Chrome match patterns, for example [\"https://x.com/*\"]. Omit to use the script's // @match header lines.",
} as const

export default {
  id: "open-extension",
  async setup(ctx) {
    const pending = new Map<
      string,
      {
        command: ScriptsCommand
        claimed: boolean
        fetched: PromiseWithResolvers<void>
        result: PromiseWithResolvers<ScriptsOutcome>
      }
    >()
    const registration = await ctx.rpc.register(ScriptsDefinition, {
      command: async (input, call) => {
        const request = pending.get(requestIDOf(input))
        // One extension runs each request, so a second browser profile never asks the user twice.
        if (!request || request.claimed)
          return call.error("unavailable", "This site script request is no longer pending.", {})
        request.claimed = true
        request.fetched.resolve()
        return request.command
      },
      result: async (input) => {
        const value = input as { requestID: string; outcome: ScriptsOutcome }
        pending.get(value.requestID)?.result.resolve(value.outcome)
        return null
      },
    })

    const send = async (command: ScriptsCommand, signal: AbortSignal) => {
      const requestID = crypto.randomUUID()
      const request = {
        command,
        claimed: false,
        fetched: Promise.withResolvers<void>(),
        result: Promise.withResolvers<ScriptsOutcome>(),
      }
      pending.set(requestID, request)
      const emit = (type: ScriptsControl["type"]) => registration.events.emit("control", { type, requestID })
      const cancel = () => {
        void emit("cancel").catch(() => undefined)
        request.result.resolve({ ok: false, message: "The request was cancelled." })
      }
      signal.addEventListener("abort", cancel, { once: true })
      const timer = (ms: number, message: string) =>
        new Promise<ScriptsOutcome>((resolve) => setTimeout(() => resolve({ ok: false, message }), ms))
      try {
        await emit("command")
        const fetched = await Promise.race([
          request.fetched.promise.then(() => true),
          request.result.promise.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), FETCH_TIMEOUT_MS)),
        ])
        if (!fetched) return { ok: false, message: notConnected } satisfies ScriptsOutcome
        return await Promise.race([
          request.result.promise,
          timer(RESULT_TIMEOUT_MS, "The user did not answer within 10 minutes. Ask them before retrying."),
        ])
      } finally {
        signal.removeEventListener("abort", cancel)
        pending.delete(requestID)
      }
    }

    const run = async (command: ScriptsCommand, signal: AbortSignal) => {
      const outcome = await send(command, signal)
      if (!outcome.ok) throw new Error(outcome.message)
      return { content: JSON.stringify(outcome.value, null, 2) }
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "site_scripts",
        description:
          "Site scripts: JavaScript that Open Extension injects into matching pages of the user's browser, like a Tampermonkey userscript but built in. Use these instead of telling the user to install a userscript manager. Scripts run in an isolated world with full access to the page DOM and storage but not the page's own JS globals; GM_* APIs are not available. After installing, verify on the real page: reload the tab with the browser tools and inspect it.",
      })
      const options = { namespace: "site_scripts", codemode: true } as const
      editor.add({
        name: "install",
        description:
          "Install or update a site script. The user approves it in the Open Extension side panel; the call waits for their answer and fails if they decline. A script with the same id, or the same name and matches, is replaced. Matching tabs pick it up on their next load.",
        input: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description:
                "Plain JavaScript run on each matching page. May start with a // ==UserScript== header (@name, @description, @match, @exclude-match, @run-at).",
            },
            name: { type: "string", description: "Short name shown to the user. Defaults to the header's @name." },
            description: { type: "string" },
            matches: patterns,
            excludeMatches: { ...patterns, description: "Chrome match patterns to skip." },
            runAt: { type: "string", enum: ["document_start", "document_end", "document_idle"] },
            id: { type: "string", description: "Existing script id to replace, from site_scripts.list." },
          },
          required: ["code"],
          additionalProperties: false,
        },
        options,
        execute: (input, tool) =>
          run({ action: "install", draft: { ...(input as { code: string }), sessionID: tool.sessionID } }, tool.signal),
      })
      editor.add({
        name: "list",
        description: "List installed site scripts (without their code): id, name, matches, enabled.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options,
        execute: (_input, tool) => run({ action: "list" }, tool.signal),
      })
      editor.add({
        name: "get",
        description: "Read one installed site script, including its code.",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        options,
        execute: (input, tool) => run({ action: "get", id: (input as { id: string }).id }, tool.signal),
      })
      editor.add({
        name: "set_enabled",
        description: "Turn an installed site script on or off without deleting it.",
        input: {
          type: "object",
          properties: { id: { type: "string" }, enabled: { type: "boolean" } },
          required: ["id", "enabled"],
          additionalProperties: false,
        },
        options,
        execute: (input, tool) => {
          const value = input as { id: string; enabled: boolean }
          return run({ action: "set_enabled", id: value.id, enabled: value.enabled }, tool.signal)
        },
      })
      editor.add({
        name: "remove",
        description: "Delete an installed site script.",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        options,
        execute: (input, tool) => run({ action: "remove", id: (input as { id: string }).id }, tool.signal),
      })
    })

    return () => {
      pending.forEach((request) => request.result.resolve({ ok: false, message: "The opencode plugin was unloaded." }))
      pending.clear()
    }
  },
} satisfies Plugin.Plugin

function requestIDOf(input: unknown) {
  return typeof input === "object" && input !== null && "requestID" in input ? String(input.requestID) : ""
}
