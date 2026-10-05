import type { PermissionOption, SessionUpdate } from "@agentclientprotocol/sdk"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client/effect"
import { FileDiff } from "@opencode/schema/file-diff"
import type { Permission } from "@opencode/schema/permission"
import type { Session } from "@opencode/schema/session"
import { Patch } from "@opencode/util/patch"
import { applyPatch, parsePatch, reversePatch } from "diff"
import { Effect, Option, Schema } from "effect"
import { ACPChild } from "./child"
import { ACPClient } from "./client"
import type { ACPConnection } from "./connection"
import {
  absolutePath,
  canonicalName,
  filePath,
  patchHunks,
  pendingToolCall,
  stringValue,
  toLocations,
  type DiffSource,
  type ToolInput,
} from "./tool"

type PermissionEvent = Extract<OpenCodeEvent, { type: "permission.asked" }>
type Tool = { readonly id: string; readonly name: string; readonly input: ToolInput }
type Preview = ReturnType<typeof diff>

type Input = {
  readonly client: OpenCodeClient
  readonly connection: ACPConnection.Interface
  readonly event: PermissionEvent
  readonly sessionID: Session.ID
  readonly clientSessionID: string
  readonly cwd: string
  readonly tool?: Tool
  readonly child?: ACPChild.Session
}

const options: PermissionOption[] = [
  { optionId: "once", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
]

const decodeFiles = Schema.decodeUnknownOption(Schema.Array(FileDiff.Info))

export const ask = Effect.fnUntraced(function* (input: Input) {
  const toolName = input.tool?.name ?? input.event.data.action
  const toolInput = input.tool?.input ?? input.event.data.metadata ?? {}
  const previews = yield* toolDiffs(toolName, toolInput, input.event.data.metadata, input.cwd, "before").pipe(
    Effect.orElseSucceed((): Preview[] => []),
  )
  const title = permissionTitle(toolName, toolInput, previews)
  const toolCall = pendingToolCall({
    toolCallId: ACPChild.toolCallID(input.child, input.tool?.id ?? input.event.data.id),
    toolName,
    state: { input: toolInput, title: title ? ACPChild.prefixTitle(input.child, title) : input.child?.title },
    cwd: input.cwd,
  })
  const result = yield* input.connection.requestPermission({
    sessionId: input.clientSessionID,
    toolCall: {
      ...toolCall,
      rawInput: input.tool ? toolCall.rawInput : undefined,
      locations: permissionLocations(toolName, toolInput, input.event.data, input.cwd),
      ...(previews.length > 0 ? { content: previews } : {}),
      ...(input.child ? { _meta: ACPChild.meta(input.child) } : {}),
    },
    options,
  })
  const selected = result.outcome.outcome === "selected" ? result.outcome.optionId : undefined
  return selected === "once" || selected === "always" ? selected : "reject"
})

export function respond(input: Input, decision: Permission.Reply) {
  return input.client.permission.reply({ sessionID: input.sessionID, requestID: input.event.data.id, decision }).pipe(
    Effect.catchTag("PermissionNotFoundError", () => Effect.void),
    Effect.catch(ACPClient.classify),
  )
}

export const withCompletedDiffs = Effect.fnUntraced(function* (
  update: SessionUpdate,
  source: DiffSource | undefined,
  cwd: string,
) {
  if (!source || update.sessionUpdate !== "tool_call_update") return update
  const diffs = yield* toolDiffs(source.toolName, source.input, source.metadata, cwd, "after").pipe(
    Effect.orElseSucceed((): Preview[] => []),
  )
  return insertDiffs(update, diffs)
})

// Core trims the patch tool's diffs for display, which breaks `applyPatch`, so its previews come from its own hunks.
const toolDiffs = Effect.fnUntraced(function* (
  toolName: string,
  input: ToolInput,
  metadata: Readonly<Record<string, unknown>> | undefined,
  cwd: string,
  disk: "before" | "after",
) {
  if (canonicalName(toolName) === "patch") return yield* patchPreviews(input, cwd, disk)
  const files = Option.getOrElse(decodeFiles(metadata?.files), () => [])
  const previews = yield* Effect.forEach(files, (file) => filePreview(file, cwd, disk), { concurrency: "unbounded" })
  return previews.flat()
})

function filePreview(file: FileDiff.Info, cwd: string, disk: "before" | "after") {
  return Effect.gen(function* () {
    const path = absolutePath(file.file, cwd)
    if (disk === "before") {
      const oldText = file.status === "added" ? null : yield* Effect.tryPromise(() => Bun.file(path).text())
      const newText = yield* Effect.try(() => applyPatch(oldText ?? "", file.patch))
      return newText === false ? [] : [diff(path, oldText, newText)]
    }
    if (file.status === "deleted") {
      const oldText = yield* Effect.try(() => applyReversed(file.patch, ""))
      return oldText === false ? [] : [diff(path, oldText, "")]
    }
    const current = yield* Effect.tryPromise(() => Bun.file(path).text())
    if (file.status === "added") return [diff(path, null, current)]
    const oldText = yield* Effect.try(() => applyReversed(file.patch, current))
    return oldText === false ? [] : [diff(path, oldText, current)]
  })
}

function patchPreviews(input: ToolInput, cwd: string, disk: "before" | "after") {
  return Effect.forEach(
    patchHunks(input),
    (hunk) =>
      Effect.gen(function* () {
        const path = absolutePath(hunk.path, cwd)
        if (hunk.type === "add") {
          if (disk === "after") {
            const current = yield* Effect.tryPromise(() => Bun.file(path).text())
            return [diff(path, null, current)]
          }
          const newText = hunk.contents.endsWith("\n") || hunk.contents === "" ? hunk.contents : `${hunk.contents}\n`
          return [diff(path, null, newText)]
        }
        if (hunk.type === "delete") {
          if (disk === "after") return []
          const oldText = yield* Effect.tryPromise(() => Bun.file(path).text())
          return [diff(path, oldText, "")]
        }
        const located = hunk.movePath ? absolutePath(hunk.movePath, cwd) : path
        if (disk === "after") {
          const chunks = reversedChunks(hunk.chunks)
          if (!chunks) return []
          const current = yield* Effect.tryPromise(() => Bun.file(located).text())
          const derived = yield* Effect.try(() => Patch.derive(hunk.path, chunks, current))
          return [diff(located, derived.content, current)]
        }
        const oldText = yield* Effect.tryPromise(() => Bun.file(path).text())
        const derived = yield* Effect.try(() => Patch.derive(hunk.path, hunk.chunks, oldText))
        return [diff(located, oldText, derived.content)]
      }),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((items) => items.flat()))
}

function applyReversed(patch: string, text: string) {
  const parsed = parsePatch(patch)[0]
  if (!parsed) return false
  return applyPatch(text, reversePatch(parsed))
}

function reversedChunks(chunks: ReadonlyArray<Patch.UpdateFileChunk>) {
  const reversed = chunks.map((chunk) => ({ ...chunk, oldLines: chunk.newLines, newLines: chunk.oldLines }))
  if (reversed.some((chunk) => chunk.oldLines.length === 0)) return undefined
  return reversed
}

function insertDiffs(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>,
  diffs: ReadonlyArray<Preview>,
) {
  if (diffs.length === 0) return update
  const content = update.content ?? []
  const imageAt = content.findIndex((part) => part.type === "content" && part.content.type === "image")
  const at = imageAt === -1 ? content.length : imageAt
  return { ...update, content: [...content.slice(0, at), ...diffs, ...content.slice(at)] }
}

function diff(path: string, oldText: string | null, newText: string) {
  return { type: "diff" as const, path, oldText, newText }
}

function permissionTitle(toolName: string, input: ToolInput, previews: ReadonlyArray<Preview>) {
  if (previews.length > 1) return `${previews.length} files`
  switch (canonicalName(toolName)) {
    case "external_directory":
      return stringValue(input.description) ?? stringValue(input.command) ?? stringValue(input.parentDir)
    case "webfetch":
      return stringValue(input.url)
    case "websearch":
      return stringValue(input.query)
    case "grep":
    case "glob":
      return stringValue(input.pattern)
    case "read":
    case "edit":
    case "write":
    case "patch":
      return filePath(input) ?? previews[0]?.path
    default:
      return undefined
  }
}

function permissionLocations(toolName: string, input: ToolInput, ask: PermissionEvent["data"], cwd: string) {
  const locations = toLocations(toolName, input, cwd)
  if (locations.length > 0 || !PathActions.has(ask.action)) return locations
  const paths = ask.resources.flatMap((resource) => {
    const path = resource.endsWith("/*") ? resource.slice(0, -2) : resource
    return path && !/[*?]/.test(path) ? [absolutePath(path, cwd)] : []
  })
  return Array.from(new Set(paths), (path) => ({ path }))
}

const PathActions = new Set(["read", "edit", "external_directory"])

export * as ACPPermission from "./permission"
