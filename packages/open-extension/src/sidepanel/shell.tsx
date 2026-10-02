// The connected panel: header, home or session, and the routing between them.
import type { Project, SessionInfo } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { For, Show, Suspense, createMemo, createSignal, lazy, onCleanup, onMount } from "solid-js"
import { useServer } from "./connection"
import { basename, toastError } from "./format"
import { Home } from "./home"

export const PROJECT_KEY = "open-extension.project"

const SessionView = lazy(() => import("./session"))

export function Shell(props: { project?: string }) {
  const server = useServer()
  const data = server.data
  const [view, setView] = createSignal<string>()
  const [projectID, setProjectID] = createSignal(props.project)
  const project = createMemo(() => {
    const list = data.project.list()
    return list.find((item) => item.id === projectID()) ?? list[0]
  })
  const session = createMemo(() => {
    const id = view()
    return id ? data.session.get(id) : undefined
  })
  const composer = { current: undefined as HTMLTextAreaElement | undefined }

  // The session chunk is heavy (timeline, markdown, diffs); compile it while home idles.
  onMount(() => {
    const idle = requestIdleCallback(() => void SessionView.preload())
    onCleanup(() => cancelIdleCallback(idle))
  })

  const focusComposer = () => requestAnimationFrame(() => composer.current?.focus())

  // Tell the background which session this panel shows, so the agent's browser follows the panel.
  const announce = (info: SessionInfo) => {
    if (view() !== info.id) return
    server.background.show({ sessionID: info.id, directory: info.location.directory })
  }

  const open = (sessionID: string) => {
    setView(sessionID)
    const info = data.session.get(sessionID)
    // A session still being created is announced once the server has it (see `create`).
    if (info && !data.session.creating(sessionID)) return announce(info)
    if (info) return
    void data.session
      .sync(sessionID)
      .then(() => {
        const loaded = data.session.get(sessionID)
        if (loaded) announce(loaded)
      })
      .catch(toastError("Couldn't open session"))
  }

  const home = () => {
    setView(undefined)
    server.background.hide()
    focusComposer()
  }

  const create = (sessionID: string, request: Promise<SessionInfo>) => {
    open(sessionID)
    void request.then(announce).catch(() => {
      if (view() === sessionID) home()
    })
  }

  const selectProject = (id: string) => {
    setProjectID(id)
    void chrome.storage.local.set({ [PROJECT_KEY]: id })
  }

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base">
      <header class="flex h-11 shrink-0 items-center gap-1 border-b border-v2-border-border-muted px-2">
        <Show when={view()} fallback={<ProjectPicker project={project()} onSelect={selectProject} />}>
          <Tooltip placement="bottom" value={session()?.parentID ? "Back to parent session" : "All sessions"}>
            <IconButton
              variant="ghost-muted"
              size="large"
              icon={<Icon name="arrow-left" />}
              aria-label="Back"
              onClick={() => {
                const parent = session()?.parentID
                if (parent) return open(parent)
                home()
              }}
            />
          </Tooltip>
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-base">
              {session()?.title || "New session"}
            </span>
            <Show when={session()?.location.directory}>
              {(directory) => (
                <span class="truncate text-12-regular leading-4 text-v2-text-text-faint">{basename(directory())}</span>
              )}
            </Show>
          </div>
        </Show>
        <Tooltip placement="bottom-end" value="New session">
          <IconButton
            variant="ghost-muted"
            size="large"
            icon={<Icon name="new-session" />}
            aria-label="New session"
            onClick={home}
          />
        </Tooltip>
      </header>
      <ConnectionNotice />
      <Show
        when={view()}
        keyed
        fallback={
          <Home
            project={project()}
            onOpen={open}
            onNew={focusComposer}
            onCreate={create}
            composerRef={(element) => (composer.current = element)}
          />
        }
      >
        {(id) => (
          <Suspense>
            <SessionView sessionID={id} onOpen={open} composerRef={(element) => (composer.current = element)} />
          </Suspense>
        )}
      </Show>
    </div>
  )
}

function ProjectPicker(props: { project?: Project; onSelect: (id: string) => void }) {
  const server = useServer()
  const projects = () => server.data.project.list()
  return (
    <div class="min-w-0 flex-1">
      <Menu gutter={4} placement="bottom-start" modal={false}>
        <Menu.Trigger
          as={Button}
          variant="ghost"
          size="normal"
          class="max-w-full justify-start ![font-weight:530]"
          disabled={projects().length === 0}
        >
          <Icon name="folder" class="shrink-0 text-v2-icon-icon-muted" />
          <span class="truncate">
            {props.project ? props.project.name || basename(props.project.canonical) : "No project"}
          </span>
          <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content class="max-h-[min(420px,70vh)] max-w-[calc(100vw-16px)] overflow-y-auto">
            <Menu.Group>
              <Menu.GroupLabel>Projects</Menu.GroupLabel>
              <Menu.RadioGroup value={props.project?.id} onChange={props.onSelect}>
                <For each={projects()}>
                  {(item) => (
                    <Menu.RadioItem value={item.id} closeOnSelect>
                      <span class="flex min-w-0 flex-col">
                        <span class="truncate">{item.name || basename(item.canonical)}</span>
                        <span class="truncate text-12-regular text-v2-text-text-faint">{item.canonical}</span>
                      </span>
                    </Menu.RadioItem>
                  )}
                </For>
              </Menu.RadioGroup>
            </Menu.Group>
            <Menu.Separator />
            <Menu.Group>
              <Menu.GroupLabel>
                <span class="truncate">
                  {server.info.url}
                  {server.info.source === "manual" ? " · manual" : ""}
                </span>
              </Menu.GroupLabel>
              <Menu.Item onSelect={() => server.background.send({ type: "service.refresh" })}>Reconnect</Menu.Item>
              <Show when={server.info.source === "manual"}>
                <Menu.Item onSelect={() => server.background.send({ type: "service.clearManual" })}>
                  Use automatic discovery
                </Menu.Item>
              </Show>
            </Menu.Group>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </div>
  )
}

function ConnectionNotice() {
  const server = useServer()
  // The first connect is quiet; only a lost or failing stream deserves a notice.
  const visible = () =>
    server.connection.status() === "reconnecting" ||
    (server.connection.status() === "connecting" && server.connection.attempt() > 1)
  return (
    <Show when={visible()}>
      <div class="flex shrink-0 items-center gap-2 border-b border-v2-border-border-muted bg-v2-state-bg-warning px-3 py-1.5 text-12-regular text-v2-state-fg-warning">
        <Icon name="warning" size="small" class="shrink-0" />
        <span class="min-w-0 flex-1 truncate" title={server.connection.error()}>
          Reconnecting to opencode{server.connection.error() ? ` — ${server.connection.error()}` : "…"}
        </span>
        <Button variant="ghost" size="small" onClick={() => server.background.send({ type: "service.refresh" })}>
          Retry
        </Button>
      </div>
    </Show>
  )
}
