// The prompt box. In a session it sends (or steers) and stops; on home it starts a session in the
// selected project. Mirrors the desktop composer's surface and controls at side panel scale.
import type { ModelInfo, ModelRef, Project, SessionInfo } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useServer } from "./connection"
import { basename, toastError } from "./format"

// Drafts outlive the composer, so switching between home and sessions keeps unsent text.
const [drafts, setDrafts] = createStore<Record<string, string>>({})

export function Composer(props: {
  sessionID?: string
  project?: Project
  onCreate?: (sessionID: string, request: Promise<SessionInfo>) => void
  ref?: (element: HTMLTextAreaElement) => void
}) {
  const server = useServer()
  const data = server.data
  const [choice, setChoice] = createStore<{ agent?: string; model?: ModelRef }>({})
  const [include, setInclude] = createSignal(false)
  const [defaults, setDefaults] = createStore<Record<string, ModelInfo | null>>({})
  const draftKey = () => props.sessionID ?? `home:${props.project?.id ?? ""}`
  const text = () => drafts[draftKey()] ?? ""
  const session = createMemo(() => (props.sessionID ? data.session.get(props.sessionID) : undefined))
  const directory = createMemo(() => session()?.location.directory ?? props.project?.canonical)
  const location = createMemo(() => {
    const value = directory()
    return value ? { directory: value } : undefined
  })
  const connected = () => server.connection.status() === "connected"

  // Remote reads for the agent and model controls of this location.
  createEffect(() => {
    const value = location()
    if (!value || !connected()) return
    void Promise.all([
      data.location.agent.sync(value),
      data.location.model.sync(value),
      data.location.provider.sync(value),
    ]).catch(toastError("Couldn't load agents and models"))
  })
  createEffect(() => {
    const value = directory()
    if (!value || !connected() || value in defaults) return
    void server.api.model
      .default({ location: { directory: value } })
      .then((response) => setDefaults(value, response.data))
      .catch(() => setDefaults(value, null))
  })

  const agents = createMemo(() =>
    (data.location.agent.list(location()) ?? []).filter((agent) => agent.mode !== "subagent" && !agent.hidden),
  )
  const models = createMemo(() => (data.location.model.list(location()) ?? []).filter((model) => model.enabled))
  const providers = createMemo(() => {
    const names = new Map((data.location.provider.list(location()) ?? []).map((item) => [item.id, item.name]))
    const groups = new Map<string, ModelInfo[]>()
    models().forEach((model) => groups.set(model.providerID, [...(groups.get(model.providerID) ?? []), model]))
    return Array.from(groups, ([id, items]) => ({ id, name: names.get(id) ?? id, models: items }))
  })
  // A new session starts like the project's most recent one, so the controls show what will run.
  const recent = createMemo(() =>
    data.session.list().find((item) => item.projectID === props.project?.id && !item.parentID),
  )
  const fallbackModel = (): ModelRef | undefined => {
    const value = directory()
    const model = value ? defaults[value] : undefined
    return model ? { id: model.id, providerID: model.providerID } : undefined
  }
  const agent = createMemo(() => {
    const current = session()
    if (current) return current.agent ?? agents()[0]?.id
    return choice.agent ?? recent()?.agent ?? agents()[0]?.id
  })
  const model = createMemo(() => {
    const current = session()
    if (current) return current.model ?? fallbackModel()
    return choice.model ?? recent()?.model ?? fallbackModel()
  })
  const modelName = () => {
    const ref = model()
    if (!ref) return "Default model"
    return models().find((item) => item.providerID === ref.providerID && item.id === ref.id)?.name ?? ref.id
  }
  const agentName = () => agents().find((item) => item.id === agent())?.name ?? agent() ?? "Agent"

  const busy = () => !!props.sessionID && data.session.status(props.sessionID) === "running"
  const stopping = () => busy() && !text().trim()
  const activeTab = () => server.background.state.activeTab
  const includable = () => !props.sessionID && !!activeTab()?.shareable

  const selectAgent = (id: string) => {
    const sessionID = props.sessionID
    if (!sessionID) return setChoice("agent", id)
    void server.api.session.switchAgent({ sessionID, agent: id }).catch(toastError("Couldn't switch agent"))
  }
  const selectModel = (ref: ModelRef) => {
    const sessionID = props.sessionID
    if (!sessionID) return setChoice("model", ref)
    void server.api.session.switchModel({ sessionID, model: ref }).catch(toastError("Couldn't switch model"))
  }

  const stop = () => {
    const sessionID = props.sessionID
    if (!sessionID) return
    void server.api.session.interrupt({ sessionID }).catch(toastError("Couldn't stop the session"))
  }

  const submit = () => {
    const value = text().trim()
    if (!value) return
    const key = draftKey()
    const restore = () => {
      if (!drafts[key]) setDrafts(key, value)
    }
    const sessionID = props.sessionID
    if (sessionID) {
      setDrafts(key, "")
      void data.session.prompt({ sessionID, text: value }).catch((error: unknown) => {
        restore()
        toastError("Couldn't send message")(error)
      })
      return
    }
    const project = props.project
    if (!project) return
    const tab = include() ? activeTab() : undefined
    const created = data.session.create({
      location: { directory: project.canonical },
      projectID: project.id,
      agent: agent(),
      model: model(),
    })
    setDrafts(key, "")
    setInclude(false)
    props.onCreate?.(created.id, created.request)
    void created.request
      .then(() => {
        // The background attaches the session's browser on `session.show`, sent by onCreate first.
        if (tab) server.background.send({ type: "tab.share", sessionID: created.id, chromeTabID: tab.chromeTabID })
      })
      .catch((error: unknown) => {
        restore()
        toastError("Couldn't start a session")(error)
      })
    void data.session.prompt({ sessionID: created.id, text: value }).catch((error: unknown) => {
      // A failed create already reported itself and rolled the session back.
      if (!data.session.get(created.id)) return
      toastError("Couldn't send message")(error)
    })
  }

  const placeholder = () => {
    if (busy()) return "Steer the agent…"
    if (props.sessionID) return "Ask a follow-up…"
    return props.project ? `Start a session in ${basename(props.project.canonical)}…` : "Ask anything…"
  }

  return (
    <form
      data-component="composer"
      class="relative w-full overflow-clip rounded-xl shadow-[var(--v2-elevation-raised)]"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <textarea
        ref={props.ref}
        rows={1}
        dir="auto"
        aria-label="Prompt"
        placeholder={placeholder()}
        value={text()}
        disabled={!props.sessionID && !props.project}
        class="block max-h-[180px] min-h-[52px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[13px] font-[440] leading-5 text-v2-text-text-base [field-sizing:content] placeholder:text-v2-text-text-faint focus:outline-none"
        onInput={(event) => setDrafts(draftKey(), event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
          event.preventDefault()
          if (event.repeat) return
          submit()
        }}
      />
      <div class="flex h-10 items-center gap-1 ps-1.5 pe-2">
        <div class="flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-x-contain no-scrollbar">
          <Show when={includable() && activeTab()}>
            {(tab) => (
              <Tooltip
                placement="top"
                value={
                  tab().sessionID
                    ? `Share “${tab().title}” with the new session. It moves from the session using it now.`
                    : `Share “${tab().title}” with the new session so the agent can use it.`
                }
              >
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="normal"
                  aria-pressed={include()}
                  class="max-w-[160px] shrink-0 justify-start ![font-weight:440]"
                  classList={{ "bg-v2-background-bg-layer-02 !text-v2-text-text-base": include() }}
                  onClick={() => setInclude((value) => !value)}
                >
                  <Favicon url={tab().favIconUrl} />
                  <span class="truncate">{include() ? "This tab" : "Include tab"}</span>
                  <Show when={include()}>
                    <Icon name="check-small" size="small" class="shrink-0" />
                  </Show>
                </Button>
              </Tooltip>
            )}
          </Show>
          <Show when={agents().length > 0}>
            <Menu gutter={6} modal={false} placement="top-start">
              <Menu.Trigger
                as={Button}
                type="button"
                variant="ghost-muted"
                size="normal"
                class="max-w-[140px] shrink-0 justify-start ![font-weight:440]"
                aria-label="Choose agent"
              >
                <span class="truncate">{agentName()}</span>
                <Icon name="chevron-down" size="small" class="-me-1 shrink-0" />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content>
                  <Menu.RadioGroup value={agent()} onChange={selectAgent}>
                    <For each={agents()}>
                      {(item) => (
                        <Menu.RadioItem value={item.id} closeOnSelect>
                          {item.name}
                        </Menu.RadioItem>
                      )}
                    </For>
                  </Menu.RadioGroup>
                </Menu.Content>
              </Menu.Portal>
            </Menu>
          </Show>
          <Menu gutter={6} modal={false} placement="top-start">
            <Menu.Trigger
              as={Button}
              type="button"
              variant="ghost-muted"
              size="normal"
              class="min-w-0 max-w-[200px] justify-start ![font-weight:440]"
              aria-label="Choose model"
              disabled={models().length === 0}
            >
              <span class="truncate">{modelName()}</span>
              <Icon name="chevron-down" size="small" class="-me-1 shrink-0" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content class="max-h-[min(420px,60vh)] max-w-[calc(100vw-16px)] overflow-y-auto">
                <Menu.RadioGroup
                  value={model() ? `${model()!.providerID}/${model()!.id}` : undefined}
                  onChange={(value) => {
                    const found = models().find((item) => `${item.providerID}/${item.id}` === value)
                    if (found) selectModel({ id: found.id, providerID: found.providerID })
                  }}
                >
                  <For each={providers()}>
                    {(provider) => (
                      <Menu.Group>
                        <Menu.GroupLabel>{provider.name}</Menu.GroupLabel>
                        <For each={provider.models}>
                          {(item) => (
                            <Menu.RadioItem value={`${item.providerID}/${item.id}`} closeOnSelect>
                              <span class="truncate">{item.name}</span>
                            </Menu.RadioItem>
                          )}
                        </For>
                      </Menu.Group>
                    )}
                  </For>
                </Menu.RadioGroup>
              </Menu.Content>
            </Menu.Portal>
          </Menu>
        </div>
        <Tooltip placement="top" inactive={!stopping() && !text().trim()} value={stopping() ? "Stop" : "Send"}>
          <IconButton
            data-action="composer-submit"
            type="button"
            variant="submit"
            class="size-7 rounded-md p-[6px]"
            disabled={!stopping() && (!text().trim() || (!props.sessionID && !props.project))}
            icon={<Icon name={stopping() ? "stop" : "arrow-up"} />}
            aria-label={stopping() ? "Stop" : "Send"}
            onClick={() => {
              if (stopping()) return stop()
              submit()
            }}
          />
        </Tooltip>
      </div>
    </form>
  )
}

export function Favicon(props: { url?: string }) {
  const globe = () => <Icon name="globe" size="small" class="shrink-0 text-v2-icon-icon-muted" />
  // Keyed by URL, so a page that fixes a broken icon gets another chance to load it.
  return (
    <Show when={props.url} keyed fallback={globe()}>
      {(url) => {
        const [failed, setFailed] = createSignal(false)
        return (
          <Show when={!failed()} fallback={globe()}>
            <img src={url} alt="" class="size-3.5 shrink-0 rounded-[3px]" onError={() => setFailed(true)} />
          </Show>
        )
      }}
    </Show>
  )
}
