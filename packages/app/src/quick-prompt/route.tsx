import type { SessionInfo } from "@opencode-ai/client/promise"
import { Select } from "@opencode-ai/ui/select"
import { createEffect, createMemo, createResource, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Composer } from "@/composer/composer"
import { createComposerModel } from "@/composer/model"
import { CommentsProvider } from "@/composer/comments"
import { ComposerPersistenceProvider, createMemoryComposerState } from "@/composer/persistence"
import { FileProvider } from "@/workspaces/files/model"
import { ModelsProvider } from "@/providers/models/models"
import { ServerProvider } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { LocationProvider } from "@/workspaces/location"
import { SessionUIProvider } from "@/shell/routes/session-ui-provider"
import { useLayout } from "@/shell/state/layout"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useGlobal } from "@/runtime/server/runtime"
import { useSettingsDialog } from "@/settings/command"
import { createProjectControls } from "@/new-session/project/controller"
import {
  createPromptProjectController,
  PromptProjectAddButton,
  PromptProjectSelector,
  type PromptProject,
} from "@/new-session/project/selector"
import { createNewSessionWorkspaceController } from "@/new-session/workspace/controller"
import { PromptGitStatus, PromptWorkspaceSelector } from "@/new-session/workspace/selector"
import { pathKey } from "@/workspaces/path-key"
import { createQuickPromptAdapter } from "./adapter"

type Target = { id: "new"; title: string } | { id: string; title: string; session: SessionInfo }

export default function QuickPromptRoute() {
  const servers = useServers()
  const layout = useLayout()
  const platform = usePlatform()
  const global = useGlobal()
  const prompt = createMemoryComposerState()
  const initial = layout.home.selection()
  const [state, setState] = createStore({
    server: initial.server,
    directory: initial.directory ?? "",
    target: "new",
    worktree: undefined as string | undefined,
    branch: undefined as string | undefined,
    contextReady: false,
    contextFound: false,
  })
  const projectControls = createProjectControls({
    directory: () => state.directory,
    server: () => state.server,
    worktree: () => state.worktree ?? "main",
    select: (selection) => {
      setState({
        server: selection.server,
        directory: selection.directory,
        target: "new",
        worktree: selection.worktree,
        branch: undefined,
      })
      layout.home.setSelection({ server: selection.server, directory: selection.directory })
    },
  })
  const projectPicker = createPromptProjectController({
    controls: projectControls,
    onDone: focusComposer,
  })
  const project = createMemo(() => {
    const directory = pathKey(state.directory)
    return projectControls().available.find(
      (project) =>
        (!project.server || project.server.key === state.server) &&
        (pathKey(project.worktree) === directory || project.sandboxes?.some((item) => pathKey(item) === directory)),
    )
  })
  const connection = createMemo(() => servers.list.find((item) => ServerConnection.key(item) === state.server))
  const selection = createMemo(() => {
    const conn = connection()
    const selectedProject = project()
    if (!conn || !selectedProject) return
    return { connection: conn, project: selectedProject }
  })

  createEffect(() => {
    if (!state.contextReady) return
    if (project() && connection()) return
    if (state.contextFound) return
    const selected = projectControls().available[0]
    const first = servers.list[0]
    const server = selected?.server?.key ?? (first ? ServerConnection.key(first) : state.server)
    if (!selected || !server) return
    setState({
      server: ServerConnection.Key.make(server),
      directory: selected.worktree,
      target: "new",
      worktree: undefined,
      branch: undefined,
    })
  })
  onMount(() => {
    const restoreContext = async () => {
      const context = await platform.getQuickPromptContext?.().catch(() => null)
      if (!context) {
        setState("contextReady", true)
        return
      }
      const connection = servers.list.find((item) => ServerConnection.key(item) === context.server)
      if (!connection) {
        setState("contextReady", true)
        return
      }
      if (context.sessionID) {
        const target = global.ensureServerCtx(connection)
        const session = await target.sdk.api.session.get({ sessionID: context.sessionID }).catch(() => undefined)
        if (!session) {
          setState("contextReady", true)
          return
        }
        target.projects.open(session.location.directory)
        target.projects.touch(session.location.directory)
        setState({
          server: ServerConnection.key(connection),
          directory: session.location.directory,
          target: session.id,
          worktree: undefined,
          branch: undefined,
          contextReady: true,
          contextFound: true,
        })
        return
      }
      if (!context.directory) {
        setState("contextReady", true)
        return
      }
      setState({
        server: ServerConnection.key(connection),
        directory: context.directory,
        target: "new",
        worktree: undefined,
        branch: undefined,
        contextReady: true,
        contextFound: true,
      })
    }
    void restoreContext()
    focusComposer()
    const focus = () => {
      void restoreContext()
      focusComposer()
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      void platform.hideWindow?.()
    }
    window.addEventListener("focus", focus)
    window.addEventListener("keydown", keydown)
    onCleanup(() => {
      window.removeEventListener("focus", focus)
      window.removeEventListener("keydown", keydown)
    })
  })

  return (
    <div data-component="quick-prompt-surface" class="fixed inset-0 z-[200] bg-v2-background-bg-deep p-2 pb-3">
      <div class="w-full">
        <Show when={selection()} keyed>
          {(selection) => (
            <ServerProvider conn={selection.connection}>
              <QuickPromptProject
                project={selection.project}
                projectPicker={projectPicker}
                prompt={prompt}
                target={() => state.target}
                setTarget={(target) => setState("target", target)}
                worktree={() => state.worktree}
                setWorktree={(worktree) => setState("worktree", worktree)}
                branch={() => state.branch}
                setBranch={(branch) => setState("branch", branch)}
              />
            </ServerProvider>
          )}
        </Show>
        <Show when={projectPicker.empty()}>
          <PromptProjectAddButton controller={projectPicker} />
        </Show>
      </div>
    </div>
  )
}

function QuickPromptProject(props: {
  project: PromptProject
  projectPicker: ReturnType<typeof createPromptProjectController>
  prompt: ReturnType<typeof createMemoryComposerState>
  target: () => string
  setTarget: (target: string) => void
  worktree: () => string | undefined
  setWorktree: (worktree: string | undefined) => void
  branch: () => string | undefined
  setBranch: (branch: string | undefined) => void
}) {
  const server = useServerSDK()
  const language = useLanguage()
  const [sessionInventory, { refetch }] = createResource(
    () => props.project.worktree,
    async () => {
      const [sessions, active] = await Promise.all([
        server.api.session
          .list({ parentID: null, limit: 100 })
          .then((response) => response.data)
          .catch(() => []),
        server.api.session
          .active()
          .then((response) => response.data)
          .catch(() => ({})),
      ])
      return { sessions, active }
    },
  )
  const targets = createMemo<Target[]>(() => {
    const directories = new Set([props.project.worktree, ...(props.project.sandboxes ?? [])].map(pathKey))
    return [
      { id: "new", title: language.t("quickPrompt.newSession") },
      ...(sessionInventory.latest?.sessions ?? [])
        .filter((session) => !session.time.archived && directories.has(pathKey(session.location.directory)))
        .map((session) => ({
          id: session.id,
          title: session.title || language.t("quickPrompt.untitledSession"),
          session,
        })),
    ]
  })
  const current = createMemo(() => targets().find((target) => target.id === props.target()) ?? targets()[0])
  let chooseDefault = true
  createEffect(() => {
    const inventory = sessionInventory.latest
    if (!chooseDefault || !inventory) return
    if (props.target() !== "new") {
      chooseDefault = false
      return
    }
    chooseDefault = false
    const running = targets()
      .filter((target): target is Extract<Target, { session: SessionInfo }> =>
        "session" in target ? target.session.id in inventory.active : false,
      )
      .sort((a, b) => b.session.time.updated - a.session.time.updated)[0]
    props.setTarget(running?.id ?? "new")
  })
  createEffect(() => {
    if (!sessionInventory.latest) return
    if (current()?.id === props.target()) return
    props.setTarget("new")
  })
  onMount(() => {
    const refresh = () => {
      chooseDefault = true
      void refetch()
    }
    window.addEventListener("focus", refresh)
    onCleanup(() => window.removeEventListener("focus", refresh))
  })

  return (
    <Show when={current()} keyed>
      {(target) => {
        const session = "session" in target ? target.session : undefined
        const directory = session?.location.directory ?? props.project.worktree
        return (
          <ModelsProvider directory={directory}>
            <LocationProvider directory={directory}>
              <SessionUIProvider
                directory={directory}
                server={ServerConnection.key(server.server)}
                sessionID={session?.id}
              >
                <FileProvider>
                  <ComposerPersistenceProvider state={props.prompt}>
                    <CommentsProvider>
                      <QuickPromptComposer
                        project={props.project}
                        projectPicker={props.projectPicker}
                        targets={targets()}
                        target={target}
                        setTarget={(target) => {
                          chooseDefault = false
                          props.setTarget(target)
                        }}
                        session={session}
                        worktree={props.worktree}
                        setWorktree={props.setWorktree}
                        branch={props.branch}
                        setBranch={props.setBranch}
                      />
                    </CommentsProvider>
                  </ComposerPersistenceProvider>
                </FileProvider>
              </SessionUIProvider>
            </LocationProvider>
          </ModelsProvider>
        )
      }}
    </Show>
  )
}

function QuickPromptComposer(props: {
  project: PromptProject
  projectPicker: ReturnType<typeof createPromptProjectController>
  targets: Target[]
  target?: Target
  setTarget: (target: string) => void
  session?: SessionInfo
  worktree: () => string | undefined
  setWorktree: (worktree: string | undefined) => void
  branch: () => string | undefined
  setBranch: (branch: string | undefined) => void
}) {
  const language = useLanguage()
  const openWorkspaces = useSettingsDialog("workspaces")
  const workspace = createNewSessionWorkspaceController({
    selectedWorktree: props.worktree,
    selectedBranch: props.branch,
    setSelectedWorktree: props.setWorktree,
    setSelectedBranch: props.setBranch,
    onViewAll: openWorkspaces,
  })
  const composer = createQuickPromptAdapter({
    session: props.session,
    projectDirectory: props.project.worktree,
    worktree: workspace.selection.value,
    branch: workspace.bar.branch,
    submitted: focusComposer,
  })
  const model = createComposerModel(composer.adapter)

  onMount(() => {
    const focus = () => model.restoreFocus()
    focus()
    window.addEventListener("focus", focus)
    onCleanup(() => window.removeEventListener("focus", focus))
  })

  return (
    <div class="flex flex-col gap-3">
      <Composer model={model} accentSubmit={workspace.selection.workspace()} />
      <div class="flex min-w-0 items-center gap-1 overflow-x-auto px-1 text-v2-text-text-faint">
        <PromptProjectSelector controller={props.projectPicker} placement="bottom-start" />
        <span class="mx-1 hidden select-none opacity-50 sm:inline">/</span>
        <Select
          options={props.targets}
          current={props.target}
          value={(target) => target.id}
          label={(target) => target.title}
          onSelect={(target) => {
            if (!target) return
            props.setTarget(target.id)
            queueMicrotask(focusComposer)
          }}
          placement="bottom-start"
          gutter={4}
        />
        <Show when={!props.session}>
          <PromptWorkspaceSelector
            value={workspace.selection.value()}
            projectRoot={workspace.project.root()}
            workspaces={workspace.project.workspaces()}
            branches={workspace.project.branches()}
            branch={workspace.bar.branch()}
            onChange={workspace.selection.set}
            onCreate={workspace.selection.create}
            onSearch={workspace.project.searchBranches}
            onDone={focusComposer}
            onViewAll={workspace.project.openAll}
          />
          <PromptGitStatus branch={workspace.bar.branch()} noGit={!workspace.project.git()} class="ms-1" />
        </Show>
        <Show when={props.session}>
          <span class="truncate px-2 text-12-regular">
            {pathKey(props.session?.location.directory ?? "") === pathKey(props.project.worktree)
              ? language.t("quickPrompt.local")
              : props.session?.location.directory.split(/[\\/]/).at(-1)}
          </span>
          <PromptGitStatus branch={workspace.bar.branch()} noGit={!workspace.project.git()} class="ms-1" />
        </Show>
      </div>
    </div>
  )
}

function focusComposer() {
  queueMicrotask(() => document.querySelector<HTMLElement>('[data-component="composer-editor"]')?.focus())
}
