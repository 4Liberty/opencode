import { createMemo } from "solid-js"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import { useGlobal, useServerCtx } from "@/runtime/server/runtime"
import { useServerSDK } from "@/runtime/server/client"
import { serverName, ServerConnection, useServers } from "@/runtime/server/registry"
import { useWorkspaceLocation } from "@/workspaces/location"
import { workspaceSelectionDestination } from "@/workspaces/paths"
import { useTabs } from "@/shell/tabs/tabs"
import type { PromptProjectControls } from "./selector"

export function createComposerProjectControls(props: { draftId: string; worktree: () => string }) {
  const serverSDK = useServerSDK()
  const location = useWorkspaceLocation()
  const tabs = useTabs()
  return createProjectControls({
    directory: () => location().directory,
    server: () => ServerConnection.key(serverSDK.server),
    worktree: props.worktree,
    select: ({ server, directory, worktree }) =>
      tabs.updateDraft(props.draftId, { server, directory, worktree, branch: undefined }),
  })
}

export function createProjectControls(props: {
  directory: () => string
  server: () => string
  worktree: () => string
  select: (selection: { server: ServerConnection.Key; directory: string; worktree: string }) => void
}) {
  const servers = useServers()
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  const projectServer = () =>
    servers.list.find((connection) => ServerConnection.key(connection) === props.server()) ?? servers.list[0]
  const projectServerCtx = useServerCtx(projectServer)
  const projects = createMemo(() => {
    if (servers.list.length <= 1) return projectServerCtx().projects.list()
    return servers.list.flatMap((connection) => {
      const server = { key: ServerConnection.key(connection), name: serverName(connection) }
      return global
        .ensureServerCtx(connection)
        .projects.list()
        .map((project) => ({ ...project, server }))
    })
  })
  const selectProject = (worktree: string, serverKey?: string) => {
    const connection = serverKey
      ? servers.list.find((item) => ServerConnection.key(item) === serverKey)
      : projectServer()
    if (!connection) return

    const target = global.ensureServerCtx(connection)
    target.projects.open(worktree)
    target.projects.touch(worktree)
    props.select({
      server: ServerConnection.key(connection),
      directory: worktree,
      worktree: workspaceSelectionDestination(props.worktree(), props.directory()),
    })
  }
  const addProject = (title: string, serverKey?: string) => {
    const connection = serverKey
      ? servers.list.find((item) => ServerConnection.key(item) === serverKey)
      : projectServer()
    if (!connection) return
    pickDirectory({
      server: connection,
      title,
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) selectProject(directory, serverKey)
      },
    })
  }

  return createMemo<PromptProjectControls>(() => ({
    available: projects(),
    directory: props.directory(),
    server: servers.list.length > 1 ? props.server() : undefined,
    select: selectProject,
    add: addProject,
  }))
}
