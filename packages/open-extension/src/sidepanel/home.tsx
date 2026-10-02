// No session open: start one in the selected project, or reopen a recent one.
import type { Project, SessionInfo } from "@opencode/client/promise"
import { Icon } from "@opencode/ui/icon"
import { Spinner } from "@opencode/ui/spinner"
import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Composer } from "./composer"
import { useServer } from "./connection"
import { basename, relativeTime, toastError } from "./format"

const pageSize = 40

export function Home(props: {
  project?: Project
  onOpen: (sessionID: string) => void
  onNew: () => void
  onCreate: (sessionID: string, request: Promise<SessionInfo>) => void
  composerRef: (element: HTMLTextAreaElement) => void
}) {
  const server = useServer()
  const data = server.data
  const [loaded, setLoaded] = createStore<Record<string, boolean>>({})
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(tick))

  // Remote read: the project's recent root sessions. Live updates then arrive through events.
  createEffect(() => {
    const id = props.project?.id
    if (!id || server.connection.status() !== "connected") return
    void server.api.session
      .list({ project: id, parentID: null, limit: pageSize, order: "desc" })
      .then((response) =>
        batch(() => {
          response.data.forEach((session) => data.session.remember(session))
          setLoaded(id, true)
        }),
      )
      .catch(toastError("Couldn't load sessions"))
  })

  const sessions = createMemo(() => {
    const id = props.project?.id
    if (!id) return []
    return data.session
      .list()
      .filter((session) => session.projectID === id && !session.parentID && !session.time.archived)
      .slice(0, pageSize)
  })

  return (
    <>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4">
        <button
          type="button"
          class="flex h-10 w-full items-center gap-2 rounded-[6px] px-2 text-start text-v2-text-text-base [font-weight:530] transition-colors duration-[120ms] hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
          onClick={props.onNew}
        >
          <Icon name="new-session" class="shrink-0 text-v2-icon-icon-muted" />
          <span class="truncate">New session</span>
        </button>
        <div class="mt-3 flex h-7 items-center px-2 text-v2-text-text-muted [font-weight:440]">Recent</div>
        <Show
          when={sessions().length > 0}
          fallback={
            <Show
              when={props.project && loaded[props.project.id]}
              fallback={
                <div class="flex flex-col gap-px" aria-hidden="true">
                  <For each={[0, 1, 2, 3]}>
                    {() => <div class="h-10 rounded-[6px] bg-v2-background-bg-deep opacity-70" />}
                  </For>
                </div>
              }
            >
              <p class="px-2 py-2 text-v2-text-text-faint">
                No sessions in {props.project ? basename(props.project.canonical) : "this project"} yet.
              </p>
            </Show>
          }
        >
          <div class="flex flex-col gap-px">
            <For each={sessions()}>
              {(session) => (
                <button
                  type="button"
                  data-component="home-session-row"
                  class="group/session flex h-10 w-full min-w-0 items-center gap-2 rounded-[6px] px-2 text-start transition-colors duration-[120ms] hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
                  onClick={() => props.onOpen(session.id)}
                >
                  <span class="min-w-0 flex-1 truncate text-v2-text-text-base [font-weight:530]">
                    {session.title || "Untitled session"}
                  </span>
                  <Show
                    when={data.session.status(session.id) === "running"}
                    fallback={
                      <span class="shrink-0 text-12-regular tabular-nums text-v2-text-text-faint">
                        {relativeTime(session.time.updated, now())}
                      </span>
                    }
                  >
                    <Spinner class="size-3.5 shrink-0 text-v2-icon-icon-muted" aria-label="Working" />
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
      <div class="shrink-0 px-2 pb-2">
        <Composer project={props.project} onCreate={props.onCreate} ref={props.composerRef} />
      </div>
    </>
  )
}
