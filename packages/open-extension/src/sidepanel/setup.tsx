// Shown until the panel has an opencode server: discovery in progress, the native host is missing,
// or the server could not be reached.
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Mark } from "@opencode/ui/logo"
import { Spinner } from "@opencode/ui/spinner"
import { TextField } from "@opencode/ui/text-field"
import { Show, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { ServiceState } from "../shared/protocol"
import type { Background } from "./port"

export function Loading(props: { label: string }) {
  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-3 text-v2-text-text-muted">
      <Spinner class="size-4" />
      <span>{props.label}</span>
    </div>
  )
}

export function Setup(props: { state: Exclude<ServiceState, { status: "ready" }>; background: Background }) {
  const [manual, setManual] = createSignal(false)
  return (
    <Show when={props.state.status === "error" && props.state} fallback={<Loading label="Connecting to opencode…" />}>
      {(error) => (
        <div class="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pt-10 pb-6">
          <Mark class="mb-5 h-6 w-auto self-start text-v2-text-text-base" />
          <Show
            when={error().hostMissing}
            fallback={
              <>
                <h1 class="text-[15px] font-[530] leading-6 text-v2-text-text-base">Can't reach opencode</h1>
                <p class="mt-1 break-words text-v2-text-text-muted">{error().message}</p>
              </>
            }
          >
            <h1 class="text-[15px] font-[530] leading-6 text-v2-text-text-base">Connect to opencode</h1>
            <p class="mt-1 text-v2-text-text-muted">
              Open Extension finds your local opencode server through a small helper app. Install it once:
            </p>
            <ol class="mt-4 flex flex-col gap-3">
              <li class="flex gap-2.5">
                <Step n={1} />
                <div class="min-w-0 flex-1">
                  <div class="text-v2-text-text-base">In a terminal, run</div>
                  <code class="mt-1.5 block rounded-md bg-v2-background-bg-layer-01 px-2.5 py-2 font-mono text-12-regular text-v2-text-text-base select-all">
                    opencode sidepanel install
                  </code>
                </div>
              </li>
              <li class="flex gap-2.5">
                <Step n={2} />
                <div class="text-v2-text-text-base">Then retry. The command also starts opencode if needed.</div>
              </li>
            </ol>
          </Show>
          <div class="mt-5 flex items-center gap-2">
            <Button variant="submit" size="normal" onClick={() => props.background.send({ type: "service.refresh" })}>
              Retry
            </Button>
            <Button variant="ghost" size="normal" onClick={() => setManual((value) => !value)}>
              Enter server manually
              <Icon name="chevron-down" size="small" classList={{ "rotate-180": manual() }} />
            </Button>
          </div>
          <Show when={manual()}>
            <ManualServer background={props.background} />
          </Show>
          <p class="mt-auto pt-8 text-12-regular text-v2-text-text-faint">Extension ID {chrome.runtime.id}</p>
        </div>
      )}
    </Show>
  )
}

function Step(props: { n: number }) {
  return (
    <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-v2-background-bg-layer-02 text-12-medium text-v2-text-text-muted">
      {props.n}
    </span>
  )
}

function ManualServer(props: { background: Background }) {
  const [form, setForm] = createStore({ url: "http://127.0.0.1:4096", password: "" })
  return (
    <form
      class="mt-4 flex flex-col gap-3 rounded-xl bg-v2-background-bg-layer-01 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        props.background.send({ type: "service.manual", url: form.url.trim(), password: form.password })
      }}
    >
      <TextField label="Server URL" value={form.url} onChange={(value) => setForm("url", value)} required />
      <TextField
        label="Password"
        type="password"
        value={form.password}
        onChange={(value) => setForm("password", value)}
        description="From `opencode service get password`."
      />
      <div class="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost-muted"
          size="small"
          onClick={() => props.background.send({ type: "service.clearManual" })}
        >
          Use automatic discovery
        </Button>
        <Button type="submit" variant="neutral" size="normal" disabled={!form.url.trim()}>
          Connect
        </Button>
      </div>
    </form>
  )
}
