// The RPC between the open-extension opencode plugin (server) and the extension's background worker.
// The plugin owns the site_scripts and browsing tools; the extension owns the data and asks the user.
// Flow: the plugin emits `control {type:"command", requestID}` on the server event stream, the extension
// fetches the command with `command`, runs it, and answers with `result`.
import type { SiteScriptDraft } from "./site-script"

export const RELAY_RPC_ID = "open-extension.relay"

export type RelayCommand =
  | { action: "list" }
  | { action: "get"; id: string }
  | { action: "install"; draft: SiteScriptDraft }
  | { action: "remove"; id: string }
  | { action: "set_enabled"; id: string; enabled: boolean }
  | { action: "history"; sessionID: string; query?: string; days?: number; limit?: number }
  | { action: "bookmarks"; sessionID: string; query?: string; limit?: number }
  | { action: "top_sites"; sessionID: string }
  | { action: "recently_closed"; sessionID: string; limit?: number }

export type RelayOutcome = { ok: true; value: unknown } | { ok: false; message: string }

export type RelayControl = { type: "command" | "cancel"; requestID: string }

const requestID = { type: "string", minLength: 1 } as const

export const RelayDefinition = {
  id: RELAY_RPC_ID,
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
