// Past conversations, out of the way: a header menu of the directory's recent root sessions.
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { Spinner } from "@opencode/ui/spinner"
import { Tooltip } from "@opencode/ui/tooltip"
import { For, Show, batch, createEffect, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useServer } from "./connection"
import { relativeTime, toastError } from "./format"

const limit = 30

export function History(props: { directory?: string; current?: string; onOpen: (sessionID: string) => void }) {
  const server = useServer()
  const data = server.data
  const [loaded, setLoaded] = createStore<Record<string, boolean>>({})
  const [now, setNow] = createSignal(Date.now())
  const sessions = createMemo(() =>
    data.session
      .list()
      .filter(
        (session) => session.location.directory === props.directory && !session.parentID && !session.time.archived,
      )
      .slice(0, limit),
  )

  // Remote read: the directory's recent root sessions, before the menu opens, so it opens filled and a new
  // conversation's controls can start like the most recent one. Live updates then arrive through events.
  createEffect(() => {
    const directory = props.directory
    if (!directory || server.connection.status() !== "connected") return
    void server.api.session
      .list({ directory, parentID: null, limit, order: "desc" })
      .then((response) =>
        batch(() => {
          response.data.forEach((session) => data.session.remember(session))
          setLoaded(directory, true)
        }),
      )
      .catch(toastError("Couldn't load conversations"))
  })

  return (
    <Tooltip placement="bottom" value="History" class="flex items-center">
      <Menu gutter={4} placement="bottom-end" modal={false} onOpenChange={(open) => open && setNow(Date.now())}>
        <Menu.Trigger
          as={IconButton}
          variant="ghost-muted"
          size="large"
          icon={<HistoryIcon />}
          aria-label="History"
          disabled={!props.directory}
        />
        <Menu.Portal>
          <Menu.Content class="w-[min(320px,calc(100vw-16px))]">
            <Menu.Group>
              <Menu.GroupLabel>Recent conversations</Menu.GroupLabel>
              <div class="-mx-0.5 max-h-[min(420px,calc(100vh-120px))] overflow-y-auto overscroll-contain px-0.5">
                <Show
                  when={sessions().length > 0}
                  fallback={
                    <Show
                      when={props.directory && loaded[props.directory]}
                      fallback={
                        <div class="flex h-16 items-center justify-center text-v2-icon-icon-muted">
                          <Spinner class="size-3.5" />
                        </div>
                      }
                    >
                      <p class="px-3 pt-1 pb-2.5 text-[13px] font-[440] leading-5 text-v2-text-text-faint">
                        No conversations here yet.
                      </p>
                    </Show>
                  }
                >
                  <For each={sessions()}>
                    {(session) => (
                      <Menu.Item
                        class="!h-8 !pe-3"
                        classList={{
                          "[&_[data-slot=menu-v2-item-content]]:![font-weight:530]": session.id === props.current,
                        }}
                        onSelect={() => props.onOpen(session.id)}
                      >
                        <span class="min-w-0 flex-1 truncate">{session.title || "Untitled conversation"}</span>
                        <Show
                          when={data.session.status(session.id) === "running"}
                          fallback={
                            <span class="shrink-0 text-[12px] font-[440] tabular-nums text-v2-text-text-faint">
                              {relativeTime(session.time.updated, now())}
                            </span>
                          }
                        >
                          <Spinner class="size-3.5 shrink-0 text-v2-icon-icon-muted" aria-label="Working" />
                        </Show>
                      </Menu.Item>
                    )}
                  </For>
                </Show>
              </div>
            </Menu.Group>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </Tooltip>
  )
}

// A clock with a counter-clockwise arrow; the shared icon set has no history glyph.
function HistoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  )
}
