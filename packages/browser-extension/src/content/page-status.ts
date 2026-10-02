// In-page status for tabs Browser Control sessions use: a small pill while a session runs, and a
// "your turn" card when a session hands the page to the user (logins, 2FA, passkeys, payments).
// Ported from anomalyco/browser-control extension/src/content-script.ts with opencode's look. Built as a
// classic script (content scripts cannot import modules) and injected at document_start on every page.
import { pageStatusFromJson, type PageStatus } from "../browser-control/protocol"

const HOST_ID = "__opencode_browser_status__"
const CURSOR_STYLE_ID = "__opencode_browser_cursor_style__"
const RELAY_CURSOR_ID = "__browser_control_ghost_cursor__"

let current: PageStatus | undefined
let completing: string | undefined
let observer: MutationObserver | undefined

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (typeof message !== "object" || message === null || !("action" in message)) return
  if (message.action === "page-status.clear") return clear()
  const status = "status" in message ? pageStatusFromJson(message.status) : undefined
  if (message.action !== "page-status.set" || !status) return
  current = status
  completing = undefined
  render()
})

void chrome.runtime.sendMessage({ action: "page-status.ready" }).catch(() => undefined)

function render() {
  if (!current || !document.documentElement) return
  styleRelayCursor()
  const host = document.getElementById(HOST_ID) ?? create()
  const root = host.shadowRoot!
  const waiting = current.state === "waiting" && current.handoffId !== undefined
  host.dataset.waiting = String(waiting)
  const pill = root.getElementById("pill")!
  const label = root.getElementById("label")!
  pill.dataset.state = current.readOnly ? "readonly" : current.state
  label.textContent =
    current.state === "waiting"
      ? "Waiting for you"
      : current.readOnly
        ? "Watching"
        : current.state === "running"
          ? "Working"
          : "Connected"
  pill.title = [
    current.owner === "session" ? "A Browser Control session opened this tab" : "You shared this tab with Browser Control",
    current.sessionId ? `Session ${current.sessionId}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
  const card = root.getElementById("card")!
  card.hidden = !waiting
  root.getElementById("vignette")!.hidden = !waiting
  if (waiting) {
    root.getElementById("message")!.textContent = current.message ?? "Finish this step, then continue."
    const button = root.getElementById("continue") as HTMLButtonElement
    button.disabled = completing === current.handoffId
    button.textContent = completing === current.handoffId ? "Continuing…" : "Continue"
    anchor(host)
  }
  if (!host.isConnected) document.documentElement.append(host)
  observer ??= new MutationObserver(() => {
    if (current && !document.getElementById(HOST_ID)) render()
  })
  observer.observe(document.documentElement, { childList: true })
}

function create() {
  const host = document.createElement("div")
  host.id = HOST_ID
  const root = host.attachShadow({ mode: "open" })
  root.innerHTML = `<style>${STYLE}</style>
    <div id="vignette" hidden></div>
    <div id="card" role="dialog" aria-labelledby="title" hidden>
      <div id="title"><span id="dot"></span>Your turn</div>
      <p id="message"></p>
      <div id="actions"><button id="continue" type="button">Continue</button></div>
    </div>
    <div id="pill" role="status" aria-live="polite">${MARK}<span id="label"></span></div>`
  root.getElementById("continue")!.addEventListener("click", () => {
    const handoffId = current?.handoffId
    if (!handoffId || completing === handoffId) return
    completing = handoffId
    render()
    void chrome.runtime.sendMessage({ action: "handoff.complete", handoffId }).catch(() => {
      completing = undefined
      render()
    })
  })
  return host
}

/** Places the card next to Browser Control's cursor when it points at the step to finish. */
function anchor(host: HTMLElement) {
  const cursor = document.getElementById(RELAY_CURSOR_ID)
  const x = Number(cursor?.dataset.targetX)
  const y = Number(cursor?.dataset.targetY)
  if (!cursor || !Number.isFinite(x) || !Number.isFinite(y)) {
    host.removeAttribute("data-anchor")
    return
  }
  const width = 320
  const height = 140
  host.style.setProperty("--card-left", `${Math.max(12, Math.min(x + 20, innerWidth - width - 12))}px`)
  host.style.setProperty("--card-top", `${y + 28 + height <= innerHeight ? y + 28 : Math.max(12, y - height - 20)}px`)
  host.dataset.anchor = "cursor"
}

/** Browser Control's relay draws its own purple cursor; give it opencode Browser's look. */
function styleRelayCursor() {
  if (document.getElementById(CURSOR_STYLE_ID)) return
  const style = document.createElement("style")
  style.id = CURSOR_STYLE_ID
  style.textContent = `#${RELAY_CURSOR_ID} path { fill: #131313 !important; stroke: #fff !important; stroke-width: 1.4px !important; }`
  ;(document.head ?? document.documentElement).append(style)
}

function clear() {
  current = undefined
  completing = undefined
  observer?.disconnect()
  observer = undefined
  document.getElementById(HOST_ID)?.remove()
}

const MARK = `<svg id="mark" viewBox="0 0 16 20" width="9" height="11" aria-hidden="true"><path d="M12 16H4V8h8v8Z" fill="currentColor" opacity=".45"/><path d="M12 4H4v12h8V4Zm4 16H0V0h16v20Z" fill="currentColor"/></svg>`

const STYLE = `
  :host { all: initial !important; position: fixed !important; right: 12px !important; bottom: 12px !important;
    z-index: 2147483647 !important; pointer-events: none !important; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif !important; }
  :host([data-waiting="true"]) { inset: 0 !important; }
  * { box-sizing: border-box; }
  #pill { position: absolute; right: 0; bottom: 0; display: inline-flex; align-items: center; gap: 6px; height: 24px;
    padding: 0 9px 0 8px; border-radius: 999px; background: rgba(19,19,19,.88); color: #ededed;
    box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 4px 14px rgba(0,0,0,.24); backdrop-filter: blur(8px);
    font-size: 11.5px; font-weight: 500; line-height: 1; letter-spacing: -.005em; white-space: nowrap; }
  :host([data-waiting="true"]) #pill { right: 12px; bottom: 12px; }
  #mark { flex: none; color: #ededed; }
  #pill::after { content: ""; width: 6px; height: 6px; border-radius: 999px; background: #8f8f8f; margin-left: 1px; }
  #pill[data-state="running"]::after { background: #f5a524; animation: pulse 1.4s ease-in-out infinite; }
  #pill[data-state="waiting"]::after { background: #3b82f6; }
  #vignette { position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(ellipse at center, transparent 62%, rgba(59,130,246,.07) 100%); animation: fade .3s ease-out both; }
  #card { position: absolute; right: 12px; bottom: 46px; width: 320px; padding: 14px 14px 12px; border-radius: 12px;
    background: #161616; color: #ededed; pointer-events: auto; user-select: text;
    box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 16px 40px rgba(0,0,0,.36); animation: enter .22s cubic-bezier(.2,.8,.2,1) both; }
  :host([data-anchor="cursor"]) #card { left: var(--card-left); top: var(--card-top); right: auto; bottom: auto; }
  #title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; line-height: 20px; }
  #dot { width: 7px; height: 7px; border-radius: 999px; background: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.2); }
  #message { margin: 4px 0 12px; color: #a1a1a1; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
  #actions { display: flex; justify-content: flex-end; }
  #continue { all: unset; cursor: pointer; height: 28px; padding: 0 12px; border-radius: 6px; background: #ededed; color: #131313;
    font-size: 13px; font-weight: 500; line-height: 28px; }
  #continue:hover { background: #fff; }
  #continue:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
  #continue:disabled { cursor: default; opacity: .6; }
  @media (prefers-color-scheme: light) {
    #pill { background: rgba(255,255,255,.92); color: #171717; box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 4px 14px rgba(0,0,0,.1); }
    #mark { color: #171717; }
    #card { background: #fff; color: #171717; box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 16px 40px rgba(0,0,0,.14); }
    #message { color: #6f6f6f; }
    #continue { background: #171717; color: #fff; }
    #continue:hover { background: #000; }
  }
  @keyframes pulse { 50% { opacity: .35; } }
  @keyframes fade { from { opacity: 0; } }
  @keyframes enter { from { opacity: 0; transform: translateY(6px) scale(.98); } }
  @media (prefers-reduced-motion: reduce) { #pill::after, #card, #vignette { animation: none !important; } }
`
