// Service worker: routes side panel requests, tracks tabs, and owns each session's browser.
import { PANEL_PORT, type ActiveTab, type ToBackground, type ToPanel } from "../shared/protocol"
import type { ScriptsCommand } from "../shared/scripts-rpc"
import { hostLabel, type SiteScript, type SiteScriptApproval, type SiteScriptDraft } from "../shared/site-script"
import { shareable } from "./policy"
import { createScriptsLink } from "./scripts-link"
import { createService } from "./service"
import { createSessionBrowser, type SessionBrowser } from "./session-browser"
import { createSiteScripts } from "./site-scripts"

type Panel = { port: chrome.runtime.Port; windowID?: number; sessionID?: string }

const panels = new Set<Panel>()
const browsers = new Map<string, Promise<SessionBrowser>>()
const service = createService((state) => broadcast(() => true, { type: "service", state }))
const scripts = createSiteScripts((state) => broadcast(() => true, { type: "scripts", state }))
const approvals = new Map<string, { approval: SiteScriptApproval; answer: (approve: boolean) => void }>()
const link = createScriptsLink({ service, run: runScriptsCommand })
let keepalive: ReturnType<typeof setInterval> | undefined

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT || port.sender?.id !== chrome.runtime.id) return
  const panel: Panel = { port }
  panels.add(panel)
  port.onMessage.addListener((message: ToBackground) => {
    void receive(panel, message).catch((error: unknown) => {
      console.warn("[open-extension]", message.type, error)
      post(panel, { type: "error", message: error instanceof Error ? error.message : String(error) })
    })
  })
  port.onDisconnect.addListener(() => {
    panels.delete(panel)
    // Site script requests are relayed while a panel is open, since only a panel can approve them.
    if (panels.size === 0) link.stop()
    void release(panel.sessionID)
  })
})

async function receive(panel: Panel, message: ToBackground) {
  switch (message.type) {
    case "panel.hello": {
      panel.windowID = message.windowID
      post(panel, { type: "service", state: service.state() })
      post(panel, { type: "scripts", state: scripts.state() })
      post(panel, { type: "approvals", approvals: pendingApprovals() })
      link.start()
      await service.get().catch(() => undefined)
      await sendActiveTab(message.windowID)
      return
    }
    case "service.refresh":
      await service.refresh().catch(() => undefined)
      return
    case "service.manual":
      await service.manual(message.url, message.password).catch(() => undefined)
      return
    case "service.clearManual":
      await service.clearManual().catch(() => undefined)
      return
    case "session.show": {
      const previous = panel.sessionID
      panel.sessionID = message.sessionID
      const browser = await ensure(message.sessionID, {
        directory: message.directory,
        ...(message.workspaceID ? { workspaceID: message.workspaceID } : {}),
      }, panel.windowID)
      browser.want(panel.windowID ?? chrome.windows.WINDOW_ID_CURRENT)
      post(panel, { type: "browser", state: browser.snapshot() })
      if (panel.windowID !== undefined) await sendActiveTab(panel.windowID)
      if (previous !== message.sessionID) await release(previous)
      return
    }
    case "session.hide": {
      const previous = panel.sessionID
      panel.sessionID = undefined
      await release(previous)
      return
    }
    case "browser.takeover":
      ;(await browsers.get(message.sessionID))?.takeover(panel.windowID ?? chrome.windows.WINDOW_ID_CURRENT)
      return
    case "tab.share": {
      const browser = await browsers.get(message.sessionID)
      if (!browser) return
      // A tab belongs to one session at a time.
      await Promise.all(
        Array.from(browsers.values(), async (other) => {
          const resolved = await other
          if (resolved !== browser) resolved.release(message.chromeTabID)
        }),
      )
      await browser.share(message.chromeTabID)
      if (panel.windowID !== undefined) await sendActiveTab(panel.windowID)
      return
    }
    case "tab.unshare":
      ;(await browsers.get(message.sessionID))?.unshare(message.tabID)
      if (panel.windowID !== undefined) await sendActiveTab(panel.windowID)
      return
    case "tab.focus":
      await (await browsers.get(message.sessionID))?.focus(message.tabID)
      return
    case "scripts.install": {
      const script = await scripts.install(message.draft)
      post(panel, { type: "notice", message: `Installed "${script.name}". Reload ${sites(script)} to run it.` })
      return
    }
    case "scripts.setEnabled":
      await scripts.setEnabled(message.id, message.enabled)
      return
    case "scripts.remove":
      await scripts.remove(message.id)
      return
    case "scripts.refresh":
      await scripts.reconcile()
      return
    case "approval.reply": {
      const pending = approvals.get(message.id)
      if (!pending) return
      approvals.delete(message.id)
      broadcastApprovals()
      pending.answer(message.approve)
      return
    }
  }
}

/** Runs a site_scripts tool call relayed from the opencode plugin. */
async function runScriptsCommand(command: ScriptsCommand, signal: AbortSignal): Promise<unknown> {
  switch (command.action) {
    case "list": {
      const state = scripts.state()
      return {
        allowed: state.available,
        ...(state.error ? { note: state.error } : {}),
        scripts: (await scripts.list()).map(summary),
      }
    }
    case "get":
      return scripts.get(command.id)
    case "install": {
      if (!(await approve(command.draft, signal))) throw new Error("The user chose Deny in the side panel; the site script was not installed.")
      const script = await scripts.install(command.draft)
      return { ...summary(script), note: `Installed. Reload ${sites(script)} to run it, then verify on the page.` }
    }
    case "remove":
      return summary(await scripts.remove(command.id))
    case "set_enabled":
      return summary(await scripts.setEnabled(command.id, command.enabled))
  }
}

/** Asks every open panel; the first answer wins. A cancelled tool call withdraws the request. */
async function approve(draft: SiteScriptDraft, signal: AbortSignal) {
  if (panels.size === 0)
    throw new Error("The Open Extension side panel is closed. Ask the user to open it so they can approve the script.")
  const approval = await scripts.preview(draft, crypto.randomUUID())
  return new Promise<boolean>((resolve) => {
    const withdraw = () => {
      if (!approvals.delete(approval.id)) return
      broadcastApprovals()
      resolve(false)
    }
    approvals.set(approval.id, {
      approval,
      answer: (approved) => {
        signal.removeEventListener("abort", withdraw)
        resolve(approved)
      },
    })
    signal.addEventListener("abort", withdraw, { once: true })
    broadcastApprovals()
  })
}

function pendingApprovals() {
  return Array.from(approvals.values(), (pending) => pending.approval)
}

function broadcastApprovals() {
  broadcast(() => true, { type: "approvals", approvals: pendingApprovals() })
}

function summary(script: SiteScript) {
  return {
    id: script.id,
    name: script.name,
    ...(script.description ? { description: script.description } : {}),
    matches: script.matches,
    ...(script.excludeMatches?.length ? { excludeMatches: script.excludeMatches } : {}),
    runAt: script.runAt,
    enabled: script.enabled,
  }
}

function sites(script: SiteScript) {
  return [...new Set(script.matches.map(hostLabel))].join(", ")
}

function ensure(sessionID: string, location: { directory: string; workspaceID?: string }, windowID?: number) {
  const existing = browsers.get(sessionID)
  if (existing) return existing
  const created = createSessionBrowser({
    sessionID,
    location,
    windowId: windowID ?? chrome.windows.WINDOW_ID_CURRENT,
    service,
    changed: (state) => {
      broadcast((panel) => panel.sessionID === sessionID, { type: "browser", state })
      const windows = new Set(Array.from(panels, (panel) => panel.windowID).filter((id) => id !== undefined))
      windows.forEach((id) => void sendActiveTab(id))
    },
  })
  browsers.set(sessionID, created)
  updateKeepalive()
  return created
}

/** A session's browser stays while a panel shows it or the agent still has tabs; then it detaches. */
async function release(sessionID: string | undefined) {
  if (!sessionID) return
  if (Array.from(panels).some((panel) => panel.sessionID === sessionID)) return
  const browser = await browsers.get(sessionID)
  if (!browser || !browser.empty) return
  browsers.delete(sessionID)
  updateKeepalive()
  await browser.dispose()
}

// Chrome stops an idle worker after 30 seconds even while a fetch stream is open. Extension API calls
// reset that timer, so ping one while any session's browser is attached.
function updateKeepalive() {
  if (browsers.size > 0 && !keepalive) keepalive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000)
  if (browsers.size === 0 && keepalive) {
    clearInterval(keepalive)
    keepalive = undefined
  }
}

async function forEachBrowser(callback: (browser: SessionBrowser) => void) {
  await Promise.all(Array.from(browsers.values(), async (browser) => callback(await browser)))
}

async function sendActiveTab(windowID: number) {
  const [tab] = await chrome.tabs.query({ active: true, windowId: windowID })
  const owners = await Promise.all(Array.from(browsers.values()))
  const active: ActiveTab | null = tab?.id
    ? {
        chromeTabID: tab.id,
        title: tab.title || tab.url || "Untitled",
        url: tab.url ?? "",
        ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
        shareable: shareable(tab.url),
        ...(() => {
          const owner = owners.find((browser) => browser.owns(tab.id!))
          return owner ? { sessionID: owner.sessionID } : {}
        })(),
      }
    : null
  broadcast((panel) => panel.windowID === windowID, { type: "activeTab", tab: active })
}

function post(panel: Panel, message: ToPanel) {
  try {
    panel.port.postMessage(message)
  } catch {
    panels.delete(panel)
  }
}

function broadcast(filter: (panel: Panel) => boolean, message: ToPanel) {
  panels.forEach((panel) => {
    if (filter(panel)) post(panel, message)
  })
}

chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  void forEachBrowser((browser) => browser.tabUpdated(tab))
  if (tab.active && (change.url || change.title || change.favIconUrl || change.status)) void sendActiveTab(tab.windowId)
})
chrome.tabs.onActivated.addListener((info) => {
  void sendActiveTab(info.windowId)
  // The previously active tab changed too; refresh every owned tab's active flag.
  void chrome.tabs.query({ windowId: info.windowId }).then((tabs) =>
    forEachBrowser((browser) => tabs.forEach((tab) => browser.tabUpdated(tab))),
  )
})
chrome.tabs.onRemoved.addListener((tabId) => {
  void forEachBrowser((browser) => browser.tabRemoved(tabId))
})
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0 || details.documentLifecycle === "prerender") return
  void forEachBrowser((browser) => browser.committed(details.tabId))
})
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return
  void forEachBrowser((browser) => browser.loadFailed(details.tabId, details.error))
})
