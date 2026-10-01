import type { SessionInfo } from "@opencode-ai/client/promise"
import { Session } from "@opencode-ai/schema/session"
import type { ActiveComposerAdapter, NewSessionComposerAdapter } from "@/composer/adapter"
import { useComposerState } from "@/composer/persistence"
import { createComposerControls, createComposerModelSelection } from "@/composer/selection"
import { useLanguage } from "@/runtime/i18n/language"
import { useLocal } from "@/providers/models/selection"
import { useData } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { useWorkspaceLocation } from "@/workspaces/location"
import { createWorktree } from "@/workspaces/create"
import { useSessionKey } from "@/session/session-layout"
import { showToast } from "@/shell/notifications/toast"
import { syncSessionModel } from "@/session/session-model-helpers"

export function createQuickPromptAdapter(props: {
  session?: SessionInfo
  projectDirectory: string
  worktree: () => string
  branch: () => string | undefined
  submitted: () => void
}) {
  const route = useSessionKey()
  const prompt = useComposerState()
  const local = useLocal()
  const data = useData()
  const server = useServerSDK()
  const location = useWorkspaceLocation()
  const language = useLanguage()
  const model = createComposerModelSelection({ agent: () => local.agent.current() })
  const controls = createComposerControls({ sessionKey: route.sessionKey, model })
  const session = props.session

  if (session) {
    if (session.agent && session.model) {
      syncSessionModel(local, {
        sessionID: session.id,
        agent: session.agent,
        model: {
          providerID: session.model.providerID,
          modelID: session.model.id,
          variant: session.model.variant,
        },
      })
    }
    const adapter: ActiveComposerAdapter = {
      kind: "active-session",
      state: prompt.capture(),
      ready: prompt.ready,
      controls,
      working: () => data.session.status(session.id) === "running",
      submitted: props.submitted,
      setEditor: () => {},
      session: () => ({
        id: session.id,
        directory: session.location.directory,
        api: server.api.session,
        data,
        current: () => data.session.get(session.id) ?? session,
        admitted: (messageID) =>
          data.session.input.has(session.id, messageID) || !!data.session.message.get(session.id, messageID),
      }),
      interrupt: () =>
        server.api.session
          .interrupt({ sessionID: session.id, continue: true })
          .then(() => undefined)
          .catch(() => undefined),
    }
    return { adapter }
  }

  const adapter: NewSessionComposerAdapter = {
    kind: "new-session",
    state: prompt.capture(),
    ready: prompt.ready,
    controls,
    working: () => false,
    submitted: props.submitted,
    async start(selection) {
      const directory = await sessionDirectory({
        projectDirectory: props.projectDirectory,
        worktree: props.worktree(),
        branch: props.branch(),
        api: server.api,
        project: data.location.info({ directory: props.projectDirectory })?.project,
      }).catch((error) => {
        showToast({
          title: language.t("prompt.toast.worktreeCreateFailed.title"),
          description: errorMessage(language, error),
        })
      })
      if (!directory) return

      const created = data.session.create({
        id: Session.ID.create(),
        agent: selection.agent,
        model: {
          id: selection.model.modelID,
          providerID: selection.model.providerID,
          variant: selection.variant,
        },
        location: { directory },
      })
      const ready = await created.request.then(
        () => true,
        (error) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(language, error),
          })
          return false
        },
      )
      if (!ready) return

      return {
        cleanupReady: Promise.resolve(),
        session: {
          id: created.id,
          directory,
          api: server.api.session,
          data,
          current: () => data.session.get(created.id),
          admitted: (messageID) =>
            data.session.input.has(created.id, messageID) || !!data.session.message.get(created.id, messageID),
        },
      }
    },
  }
  return { adapter }
}

async function sessionDirectory(input: {
  projectDirectory: string
  worktree: string
  branch?: string
  api: ReturnType<typeof useServerSDK>["api"]
  project?: Parameters<typeof createWorktree>[0]["project"]
}) {
  if (input.worktree === "main") return input.projectDirectory
  if (input.worktree !== "create") return input.worktree
  return createWorktree({
    api: input.api,
    directory: input.projectDirectory,
    project: input.project,
    branch: input.branch,
  })
}

function errorMessage(language: ReturnType<typeof useLanguage>, error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  return language.t("common.requestFailed")
}
