// Site scripts in the panel: agents' install requests, userscripts found in replies, and the installed
// list. The background owns the scripts and their registrations; the panel mirrors them and asks.
import type { SessionMessageInfo } from "@opencode/client/promise"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Switch } from "@opencode/ui/switch"
import { Tooltip } from "@opencode/ui/tooltip"
import { For, Show, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { hostLabel, parseHeader, resolveDraft } from "../shared/site-script"
import { useServer } from "./connection"

// Userscripts the user dismissed from the install card, by code, for the panel's lifetime.
const [dismissed, setDismissed] = createStore<Record<string, true>>({})

/** The oldest agent install request, as a dock above the composer. Any session's request shows here. */
export function ScriptApprovalDock() {
  const background = useServer().background
  const approval = () => background.state.approvals[0]
  const total = () => background.state.approvals.length
  const available = () => background.state.scripts.available
  // IDs rather than flags, so a new request starts collapsed and answerable.
  const [expanded, setExpanded] = createSignal<string>()
  const [answered, setAnswered] = createSignal<string>()
  const open = () => expanded() === approval()?.id
  const busy = () => answered() === approval()?.id

  const reply = (approve: boolean) => {
    const id = approval()?.id
    if (!id || answered() === id) return
    setAnswered(id)
    background.send({ type: "approval.reply", id, approve })
  }

  return (
    <Show when={approval()}>
      {(request) => (
        <DockPrompt
          kind="permission"
          header={
            <div data-slot="permission-row" data-variant="header">
              <span data-slot="permission-icon">
                <Icon name="code" size="normal" />
              </span>
              <div class="flex min-w-0 items-center justify-between gap-2">
                <div data-slot="permission-header-title">
                  {request().replaces ? "Update site script?" : "Install site script?"}
                </div>
                <Show when={total() > 1}>
                  <span class="shrink-0 text-12-regular tabular-nums text-v2-text-text-faint">1 of {total()}</span>
                </Show>
              </div>
            </div>
          }
          footer={
            <>
              <div />
              <div data-slot="permission-footer-actions">
                <Button variant="ghost" size="normal" disabled={busy()} onClick={() => reply(false)}>
                  Deny
                </Button>
                <Button variant="submit" size="normal" disabled={busy() || !available()} onClick={() => reply(true)}>
                  {request().replaces ? "Update" : "Install"}
                </Button>
              </div>
            </>
          }
        >
          <div data-slot="permission-row" class="min-h-0">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div class="-mx-1 flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto px-1 pb-3">
              <div class="flex min-w-0 flex-col">
                <span class="text-[14px] font-[530] leading-5 break-words text-v2-text-text-base">
                  {request().script.name}
                </span>
                <span class="text-[13px] leading-5 break-words text-v2-text-text-muted">
                  Runs on {sites(request().script.matches)}
                </span>
              </div>
              <Show when={request().script.description}>
                {(description) => (
                  <p class="text-[13px] leading-5 break-words text-v2-text-text-muted">{description()}</p>
                )}
              </Show>
              <Show when={request().replaces}>
                {(replaces) => (
                  <p class="text-12-regular text-v2-text-text-faint">Replaces the installed “{replaces().name}”.</p>
                )}
              </Show>
              <For each={request().warnings}>
                {(warning) => (
                  <p class="flex gap-1.5 text-12-regular text-v2-state-fg-warning">
                    <Icon name="warning" size="small" class="mt-px shrink-0" />
                    <span class="min-w-0 break-words">{warning}</span>
                  </p>
                )}
              </For>
              <div class="flex flex-col gap-1.5">
                <Button
                  variant="ghost-muted"
                  size="small"
                  class="-ms-2 self-start"
                  aria-expanded={open()}
                  onClick={() => setExpanded(open() ? undefined : request().id)}
                >
                  {open() ? "Hide code" : "Show code"}
                  <Icon name="chevron-down" size="small" classList={{ "rotate-180": open() }} />
                </Button>
                <Show when={open()}>
                  <CodePreview code={request().script.code} />
                </Show>
              </div>
              <Show when={!available()}>
                <ScriptsUnavailable />
              </Show>
            </div>
          </div>
        </DockPrompt>
      )}
    </Show>
  )
}

/** The most recent userscript in the session's replies, with a one-click install. */
export function ScriptInstallCard(props: { sessionID: string }) {
  const server = useServer()
  const background = server.background
  const found = createMemo(() => latestUserscript(server.data.session.message.list(props.sessionID)))
  const script = () => {
    const value = found()
    return value && !dismissed[value.code] ? value : undefined
  }
  // The background replaces a script with the same name and matches instead of adding another.
  const installed = createMemo(() => {
    const value = script()
    if (!value) return
    return background.state.scripts.scripts.find(
      (item) => item.name === value.name && sameMatches(item.matches, value.matches),
    )
  })
  const status = () => {
    const existing = installed()
    if (!existing) return "install"
    return existing.code === script()?.code ? "installed" : "update"
  }
  const available = () => background.state.scripts.available

  return (
    <Show when={script()}>
      {(value) => (
        <div
          data-component="script-install-card"
          class="flex flex-col gap-2 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-1.5 ps-2.5"
        >
          <div class="flex min-w-0 items-center gap-2">
            <Icon name="code" size="small" class="shrink-0 text-v2-icon-icon-muted" />
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="truncate text-[13px] font-[530] leading-[18px] text-v2-text-text-base">{value().name}</span>
              <span class="truncate text-12-regular leading-4 text-v2-text-text-faint">
                Site script for {sites(value().matches)}
              </span>
            </div>
            <Show
              when={status() !== "installed"}
              fallback={
                <Button variant="ghost-muted" size="small" class="shrink-0" disabled>
                  <Icon name="check-small" size="small" />
                  Installed
                </Button>
              }
            >
              <Button
                variant={status() === "update" ? "neutral" : "submit"}
                size="small"
                class="shrink-0"
                disabled={!available()}
                onClick={() =>
                  background.send({
                    type: "scripts.install",
                    draft: { code: value().code, sessionID: props.sessionID },
                  })
                }
              >
                {status() === "update" ? "Update" : "Install"}
              </Button>
            </Show>
            <Tooltip placement="top-end" value="Dismiss">
              <IconButton
                variant="ghost-muted"
                size="normal"
                class="shrink-0"
                icon={<Icon name="close-small" size="small" />}
                aria-label="Dismiss"
                onClick={() => setDismissed(value().code, true)}
              />
            </Tooltip>
          </div>
          <Show when={!available()}>
            <div class="pe-1 pb-1">
              <ScriptsUnavailable />
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}

/** Installed scripts: turn each on or off, or delete it. */
export function SiteScriptsView() {
  const background = useServer().background
  const scripts = () => background.state.scripts.scripts
  const available = () => background.state.scripts.available
  const [confirming, setConfirming] = createSignal<string>()

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      <Show when={!available()}>
        <div class="px-3 pt-3">
          <div class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
            <ScriptsUnavailable />
          </div>
        </div>
      </Show>
      <Show
        when={scripts().length > 0}
        fallback={
          <div class="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-8 text-center">
            <Icon name="code" size="large" class="text-v2-icon-icon-muted opacity-60" />
            <p class="max-w-[248px] text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint">
              No site scripts yet. Ask the agent to change how a site looks or works.
            </p>
          </div>
        }
      >
        <ul class="flex flex-col py-1.5">
          <For each={scripts()}>
            {(script) => (
              <li class="group/script flex min-h-12 items-center gap-3 px-3 py-2">
                <div class="flex min-w-0 flex-1 flex-col">
                  <span
                    class="truncate text-[13px] font-[530] leading-[18px]"
                    classList={{
                      "text-v2-text-text-base": script.enabled,
                      "text-v2-text-text-muted": !script.enabled,
                    }}
                  >
                    {script.name}
                  </span>
                  <span
                    class="truncate text-12-regular leading-4 text-v2-text-text-faint"
                    title={script.matches.join("\n")}
                  >
                    {sites(script.matches)}
                  </span>
                  <Show when={script.description}>
                    {(description) => (
                      <span class="truncate text-12-regular leading-4 text-v2-text-text-faint" title={description()}>
                        {description()}
                      </span>
                    )}
                  </Show>
                </div>
                <Show
                  when={confirming() === script.id}
                  fallback={
                    <>
                      <Switch
                        hideLabel
                        checked={script.enabled}
                        disabled={!available()}
                        onChange={(enabled) => background.send({ type: "scripts.setEnabled", id: script.id, enabled })}
                      >
                        {`Run ${script.name}`}
                      </Switch>
                      <Tooltip placement="top-end" value="Delete">
                        <IconButton
                          variant="ghost-muted"
                          size="normal"
                          class="shrink-0"
                          icon={<Icon name="trash" size="small" />}
                          aria-label={`Delete ${script.name}`}
                          onClick={() => setConfirming(script.id)}
                        />
                      </Tooltip>
                    </>
                  }
                >
                  <div class="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" size="small" onClick={() => setConfirming(undefined)}>
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      size="small"
                      onClick={() => {
                        setConfirming(undefined)
                        background.send({ type: "scripts.remove", id: script.id })
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

/** How to allow user scripts, which Chromium keeps off per extension until the user turns it on. */
function ScriptsUnavailable() {
  const background = useServer().background
  return (
    <div data-component="scripts-unavailable" class="flex flex-col gap-2 text-12-regular">
      <p class="flex items-center gap-1.5 font-[530] text-v2-state-fg-warning">
        <Icon name="warning" size="small" class="shrink-0" />
        Site scripts are turned off in this browser
      </p>
      <ol class="flex list-decimal flex-col gap-0.5 ps-[34px] text-v2-text-text-muted marker:text-v2-text-text-faint">
        <li>
          Open the extensions page (<span class="font-mono">helium://extensions</span> in Helium)
        </li>
        <li>Choose Details on Open Extension</li>
        <li>
          Turn on <span class="font-[530] text-v2-text-text-base">Allow user scripts</span>
        </li>
      </ol>
      <div class="flex items-center gap-1 ps-5">
        <Button
          variant="neutral"
          size="small"
          onClick={() => void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })}
        >
          Open extensions page
        </Button>
        <Button variant="ghost" size="small" onClick={() => background.send({ type: "scripts.refresh" })}>
          Check again
        </Button>
      </div>
    </div>
  )
}

function CodePreview(props: { code: string }) {
  return (
    <pre class="max-h-[200px] overflow-auto overscroll-contain rounded-md bg-v2-background-bg-layer-02 px-2.5 py-2 font-mono text-[12px] leading-[18px] whitespace-pre text-v2-text-text-base">
      {props.code}
    </pre>
  )
}

/** Readable, deduplicated sites for match patterns: `example.com, x.com`. */
function sites(matches: string[]) {
  return Array.from(new Set(matches.map(hostLabel))).join(", ")
}

function sameMatches(a: string[], b: string[]) {
  return a.length === b.length && a.every((pattern) => b.includes(pattern))
}

const fence = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g
const languages = new Set(["", "js", "javascript"])

/** The newest installable userscript in a session's assistant replies. */
function latestUserscript(messages: SessionMessageInfo[]) {
  // Newest first, stopping at the first hit; streaming re-runs this on every delta.
  for (const message of messages.toReversed()) {
    if (message.type !== "assistant") continue
    const found = message.content.flatMap((part) => (part.type === "text" ? userscripts(part.text) : [])).at(-1)
    if (found) return found
  }
}

function userscripts(text: string) {
  if (!text.includes("==UserScript==")) return []
  return Array.from(text.matchAll(fence)).flatMap((match) => {
    const code = match[2].trimEnd()
    if (!languages.has(match[1].toLowerCase()) || !parseHeader(code)?.matches.length) return []
    const script = resolveDraft({ code }).script
    return [{ code, name: script.name, matches: script.matches }]
  })
}
