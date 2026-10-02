// Messages between the side panel and the background service worker. Each panel holds one long-lived
// `chrome.runtime.connect({ name: PANEL_PORT })` port; the open port also keeps the worker alive.

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

export type ToPanel =
  | { type: "service"; state: ServiceState }
  | { type: "browser"; state: BrowserState }
  | { type: "activeTab"; tab: ActiveTab | null }
