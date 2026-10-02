// Messages between the side panel and the background service worker. Each panel holds one long-lived
// `chrome.runtime.connect({ name: PANEL_PORT })` port; the open port also keeps the worker alive.

import type { SiteScriptApproval, SiteScriptDraft, SiteScriptsState } from "./site-script"

export const PANEL_PORT = "open-extension.panel"

export type ServiceInfo = { url: string; password: string; source: "host" | "manual" }

export type ServiceState =
  | { status: "loading" }
  | { status: "ready"; info: ServiceInfo }
  | { status: "error"; message: string; hostMissing: boolean }

/**
 * - idle: no attachment requested for this session.
 * - connecting: attaching or reconnecting after a dropped connection.
 * - connected: the agent can use this session's tabs.
 * - replaced: another client (usually the desktop app) took the session's browser.
 * - unsupported: the server has no compatible browser plugin.
 */
export type BrowserStatus = "idle" | "connecting" | "connected" | "replaced" | "unsupported"

export type PanelTab = {
  /** The tab ID the agent sees, `tab_<uuid>`. */
  id: string
  chromeTabID: number
  title: string
  url: string
  favIconUrl?: string
  /** opened: the agent opened it. shared: the user shared an existing tab. */
  kind: "opened" | "shared"
  active: boolean
  loading: boolean
}

export type BrowserState = {
  sessionID: string
  status: BrowserStatus
  error?: string
  tabs: PanelTab[]
}

export type ActiveTab = {
  chromeTabID: number
  title: string
  url: string
  favIconUrl?: string
  /** http(s) pages only; browser pages and the web store cannot be debugged. */
  shareable: boolean
  /** The session that already has this tab, if any. */
  sessionID?: string
}

/** One grant covers history, bookmarks, top sites, and recently closed tabs for a session. */
export type AccessRequest = {
  id: string
  sessionID: string
  /** What the agent asked for first, for example "history". */
  reason: "history" | "bookmarks" | "top_sites" | "recently_closed"
}

export type ToBackground =
  | { type: "panel.hello"; windowID: number }
  | { type: "service.refresh" }
  | { type: "service.manual"; url: string; password: string }
  | { type: "service.clearManual" }
  /** Show this session in the panel: attach its browser unless the user turned it off. */
  | { type: "session.show"; sessionID: string; directory: string; workspaceID?: string }
  | { type: "session.hide" }
  /** Take the session's browser back after another client replaced it. */
  | { type: "browser.takeover"; sessionID: string }
  | { type: "tab.share"; sessionID: string; chromeTabID: number }
  | { type: "tab.unshare"; sessionID: string; tabID: string }
  | { type: "tab.focus"; sessionID: string; tabID: string }
  /** The user installed a script from the panel (for example a userscript in a reply); no approval needed. */
  | { type: "scripts.install"; draft: SiteScriptDraft }
  | { type: "scripts.setEnabled"; id: string; enabled: boolean }
  | { type: "scripts.remove"; id: string }
  /** Re-check whether site scripts are allowed, after the user changes the browser setting. */
  | { type: "scripts.refresh" }
  /** The user's answer to an agent's install request. */
  | { type: "approval.reply"; id: string; approve: boolean }
  /** The user's answer to a request to read browsing history and bookmarks. */
  | { type: "access.reply"; id: string; allow: boolean }

export type ToPanel =
  | { type: "service"; state: ServiceState }
  | { type: "browser"; state: BrowserState }
  | { type: "activeTab"; tab: ActiveTab | null }
  /** A panel request failed, for example sharing a tab the browser will not let extensions debug. */
  | { type: "error"; message: string }
  | { type: "scripts"; state: SiteScriptsState }
  /** Agent install requests waiting for the user, oldest first. Any open panel may answer. */
  | { type: "approvals"; approvals: SiteScriptApproval[] }
  /** A panel-initiated script change succeeded; for confirmation toasts. */
  | { type: "notice"; message: string }
  /** Sessions asking to read browsing history, bookmarks, top sites, and recently closed tabs. */
  | { type: "access"; requests: AccessRequest[] }
  /** The agent asked to show a server file (browser.preview) in the panel showing this session. */
  | { type: "preview"; sessionID: string; path: string }
