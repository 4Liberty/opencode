// The RPC between the open-extension opencode plugin (server) and the extension's background worker.
// The plugin owns the site_scripts tools; the extension owns the scripts and asks the user to approve.
// Flow: the plugin emits `control {type:"command", requestID}` on the server event stream, the extension
// fetches the command with `command`, runs it, and answers with `result`.
import type { SiteScriptDraft } from "./site-script"

export const SCRIPTS_RPC_ID = "open-extension.scripts"

export type ScriptsCommand =
  | { action: "list" }
  | { action: "get"; id: string }
  | { action: "install"; draft: SiteScriptDraft }
  | { action: "remove"; id: string }
  | { action: "set_enabled"; id: string; enabled: boolean }

export type ScriptsOutcome = { ok: true; value: unknown } | { ok: false; message: string }

export type ScriptsControl = { type: "command" | "cancel"; requestID: string }

const requestID = { type: "string", minLength: 1 } as const

export const ScriptsDefinition = {
  id: SCRIPTS_RPC_ID,
  methods: {
    command: {
      input: { type: "object", properties: { requestID }, required: ["requestID"] },
      output: { type: "object" },
      errors: { unavailable: { type: "object" } },
    },
    result: {
      input: {
        type: "object",
        properties: { requestID, outcome: { type: "object" } },
        required: ["requestID", "outcome"],
      },
      output: {},
    },
  },
  events: {
    control: {
      schema: {
        type: "object",
        properties: { type: { type: "string", enum: ["command", "cancel"] }, requestID },
        required: ["type", "requestID"],
      },
    },
  },
} as const
