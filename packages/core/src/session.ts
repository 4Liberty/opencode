export * as Session from "./session.js"
export * from "./session/schema.js"

import { DateTime, Effect, Fiber, Layer, Schema, Scope, Context, Stream } from "effect"
import { LLMClient } from "@opencode/ai"
import { ListAnchor } from "@opencode/schema/session"
import { and, desc, eq } from "drizzle-orm"
import { Project } from "./project.js"
import { Model } from "@opencode/schema/model"
import { Location } from "./location.js"
import { SessionMessage } from "./session/message.js"
import { PromptInput } from "@opencode/schema/prompt-input"
import { Bus } from "./bus.js"
import { Instance } from "./instance/service.js"
import { Database } from "./database/database.js"
import { SessionProjector } from "./session/projector.js"
import { SessionMessageTable } from "./session/sql.js"
import { SessionSchema } from "./session/schema.js"
import { RelativePath } from "./schema.js"
import { Agent } from "@opencode/schema/agent"
import type { Permission } from "@opencode/schema/permission"
import { App } from "./app.js"
import { Slug } from "./util/slug.js"
import path from "path"
import { SessionRunner } from "./session/runner/index.js"
import { SessionStore } from "./session/store.js"
import { SessionExecution } from "./session/execution.js"
import {
  AttachmentError,
  BusyError,
  CompactionConflictError,
  ForkEmptyError,
  InboxConflictError,
  MessageDecodeError,
  MessageNotFoundError,
  NotFoundError,
  PromptConflictError,
  SkillNotFoundError,
  SyntheticConflictError,
} from "./session/error.js"
import { Node } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { SessionEvent } from "./session/event.js"
import { SessionInbox } from "./session/inbox.js"
import { InstructionState } from "./session/instruction-state.js"
import { SessionGenerate } from "./session/generate.js"
import {
  SessionMove,
  DestinationNotFoundError,
  DestinationNotDirectoryError,
  DestinationUnavailableError,
} from "./session/move.js"
import { SessionModelTransport } from "./session/model-transport.js"
import { llmClient } from "./effect/app-node-platform.js"
import { Snapshot } from "./snapshot.js"
import { SessionDiff, TurnRangeError } from "./session/diff.js"
import { LocationServiceMap } from "./location-service-map.js"
import { FSUtil } from "@opencode/util/fs-util"
import type { EventLog } from "@opencode/schema/event-log"
import type { FileDiff } from "@opencode/schema/file-diff"
import { Job } from "./job.js"
import { Command } from "./command.js"
import { SessionEnvironment } from "./session/environment.js"
import { InstructionEntry } from "./session/instruction-entry.js"
import { SessionPrompt } from "./session/prompt.js"
import { SessionRevert } from "./session/revert.js"
import { Plugin } from "./plugin/service.js"
import { Shell } from "./shell.js"
import { ShellResult } from "./shell/result.js"
import { Skill } from "./skill.js"
import { Event } from "@opencode/schema/event"

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

export const ListInput = SessionStore.ListInput
export type ListInput = SessionStore.ListInput

type CreateBaseInput = {
  id?: SessionSchema.ID
  title?: string
  agent?: Agent.ID
  model?: Model.Ref
  metadata?: SessionSchema.Metadata
  permissions?: Permission.Ruleset
}
type CreateInput = CreateBaseInput &
  ({ location: Location.Ref; parentID?: never } | { parentID: SessionSchema.ID; location?: never })

type ForkInput = {
  sessionID: SessionSchema.ID
  before?: SessionMessage.ID
}

export {
  AttachmentError,
  BusyError,
  CompactionConflictError,
  InboxConflictError,
  MessageDecodeError,
  MessageNotFoundError,
  NotFoundError,
  PromptConflictError,
  SkillNotFoundError,
  SyntheticConflictError,
}
type InboxItemRef = { readonly sessionID: SessionSchema.ID; readonly inboxID: SessionMessage.ID }

export { DestinationNotFoundError, DestinationNotDirectoryError, DestinationUnavailableError }
export { TurnRangeError }

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<{
    readonly data: SessionSchema.Info[]
  }>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly fork: (
    input: ForkInput,
  ) => Effect.Effect<SessionSchema.Info, NotFoundError | MessageNotFoundError | ForkEmptyError>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly environment: (input: {
    readonly sessionID: SessionSchema.ID
    readonly variables?: SessionEnvironment.Variables
  }) => Effect.Effect<SessionEnvironment.Variables | undefined, NotFoundError>
  readonly view: (input: { sessionID: SessionSchema.ID; idle: number }) => Effect.Effect<void, NotFoundError>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly messages: (
    input: SessionStore.MessagesInput,
  ) => Effect.Effect<SessionMessage.Info[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Info | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Info[], NotFoundError | MessageDecodeError>
  /** Structured diffs of the files changed by a turn or range of turns; see `SessionDiff.turn`. */
  readonly diff: (input: {
    readonly sessionID: SessionSchema.ID
    readonly from?: SessionMessage.ID
    readonly to?: SessionMessage.ID
    readonly context?: number
  }) => Effect.Effect<readonly FileDiff.Info[], NotFoundError | MessageNotFoundError | TurnRangeError | Snapshot.Error>
  /**
   * Durable admitted session work not yet visible in projected history,
   * ordered by admission. Includes unpromoted user and synthetic inputs and
   * unhandled compaction barriers.
   */
  readonly inbox: (sessionID: SessionSchema.ID) => Effect.Effect<SessionInbox.Info[], NotFoundError>
  readonly cancelInbox: (input: InboxItemRef) => Effect.Effect<void, NotFoundError | InboxConflictError>
  readonly steerInbox: (input: InboxItemRef) => Effect.Effect<void, NotFoundError | InboxConflictError>
  readonly queueInbox: (input: InboxItemRef) => Effect.Effect<void, NotFoundError | InboxConflictError>
  /**
   * Durable, ordered session log read. Replays durable session bus after
   * the exclusive `after` cursor, emits a `Synced` marker at the captured
   * replay watermark, then continues live when `follow` is set.
   * The marker's seq may exceed the last emitted event because other durable
   * bus share the aggregate's sequence space.
   */
  readonly log: (input: {
    sessionID: SessionSchema.ID
    after?: number
    follow?: boolean
  }) => Stream.Stream<SessionEvent.DurableEvent | EventLog.Synced, NotFoundError>
  readonly switchAgent: (input: { sessionID: SessionSchema.ID; agent: Agent.ID }) => Effect.Effect<void, NotFoundError>
  readonly switchModel: (input: { sessionID: SessionSchema.ID; model: Model.Ref }) => Effect.Effect<void, NotFoundError>
  readonly rename: (input: { sessionID: SessionSchema.ID; title: string }) => Effect.Effect<void, NotFoundError>
  readonly setMetadata: (input: {
    sessionID: SessionSchema.ID
    metadata: SessionSchema.Metadata
  }) => Effect.Effect<void, NotFoundError>
  readonly setPermissions: (input: {
    sessionID: SessionSchema.ID
    permissions: Permission.Ruleset
  }) => Effect.Effect<void, NotFoundError>
  readonly move: SessionMove.Interface["move"]
  readonly prompt: (
    input: SessionPrompt.Input & { sessionID: SessionSchema.ID; id?: SessionMessage.ID; resume?: boolean },
  ) => Effect.Effect<SessionInbox.User, NotFoundError | PromptConflictError | AttachmentError | SkillNotFoundError>
  /** Generates text from current Session context without admitting input or mutating history. */
  readonly generate: (input: {
    sessionID: SessionSchema.ID
    prompt: string
  }) => Effect.Effect<string, NotFoundError | SessionGenerate.Error>
  readonly command: (input: {
    sessionID: SessionSchema.ID
    command: string
    text: string
    files?: PromptInput.Prompt["files"]
    agents?: PromptInput.Prompt["agents"]
    skills?: PromptInput.Prompt["skills"]
    delivery?: SessionInbox.Delivery
  }) => Effect.Effect<void, NotFoundError | Command.NotFoundError | Command.ExecutionError>
  readonly shell: (input: {
    sessionID: SessionSchema.ID
    id?: SessionMessage.ID
    command: string
  }) => Effect.Effect<void, NotFoundError>
  readonly skill: (input: {
    sessionID: SessionSchema.ID
    messageID?: SessionMessage.ID
    skill: Skill.ID
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError | SkillNotFoundError>
  readonly compact: (input: {
    sessionID: SessionSchema.ID
    id?: SessionMessage.ID
    delivery?: SessionInbox.Delivery
  }) => Effect.Effect<SessionInbox.Compaction, NotFoundError | CompactionConflictError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly background: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID, options?: { readonly resume?: boolean }) => Effect.Effect<boolean>
  readonly synthetic: (input: {
    sessionID: SessionSchema.ID
    id?: SessionMessage.ID
    text: string
    description?: string
    metadata?: Record<string, unknown>
    delivery?: SessionInbox.Delivery
    resume?: boolean
  }) => Effect.Effect<SessionInbox.Synthetic, NotFoundError | SyntheticConflictError>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<SessionSchema.Revert, NotFoundError | MessageNotFoundError | BusyError | Snapshot.Error>
    readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | BusyError | Snapshot.Error>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | BusyError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const app = yield* App.Metadata
    const database = yield* Database.Service
    const db = database.db
    const bus = yield* Bus.Service
    const projects = yield* Project.Service
    const execution = yield* SessionExecution.Service
    const llm = yield* LLMClient.Service
    const transport = yield* SessionModelTransport.Service
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service
    const moves = yield* SessionMove.Service
    const jobs = yield* Job.Service
    const environments = yield* SessionEnvironment.Service
    const locations = yield* LocationServiceMap.Service
    const admission = yield* SessionInbox.Service
    const fs = yield* FSUtil.Service
    const scope = yield* Scope.Scope
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)

    const mutatePending = (
      input: InboxItemRef,
      mutation: (input: {
        readonly id: SessionMessage.ID
        readonly sessionID: SessionSchema.ID
      }) => Effect.Effect<void, SessionInbox.LifecycleConflict>,
    ) =>
      mutation({ sessionID: input.sessionID, id: input.inboxID }).pipe(
        Effect.catchTag("SessionInbox.LifecycleConflict", () =>
          Effect.gen(function* () {
            yield* result.get(input.sessionID)
            return yield* new InboxConflictError({ sessionID: input.sessionID, inboxID: input.inboxID })
          }),
        ),
      )

    const result = Service.of({
      create: Effect.fn("Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        const parent = input.parentID ? yield* store.get(input.parentID) : undefined
        if (input.parentID && parent === undefined) return yield* new NotFoundError({ sessionID: input.parentID })
        const location = parent?.location ?? input.location
        if (location === undefined)
          return yield* Effect.die(new Error("Session.create requires either location or an existing parentID"))
        const project = yield* projects.resolve(location.directory)
        const projected = yield* bus
          .publish(
            SessionEvent.Created,
            {
              sessionID,
              slug: Slug.create(),
              version: app.version,
              projectID: project.id,
              parentID: input.parentID,
              location,
              subpath: RelativePath.make(path.relative(project.directory, location.directory).replaceAll("\\", "/")),
              title: input.title,
              agent: input.agent,
              // Children inherit metadata and permissions the way they inherit
              // location, so host policies that read them treat the family uniformly.
              metadata: input.metadata ?? parent?.metadata,
              permissions: input.permissions ?? parent?.permissions,
              model: input.model
                ? {
                    id: Model.ID.make(input.model.id),
                    providerID: input.model.providerID,
                    variant: input.model.variant,
                  }
                : undefined,
            },
            { location },
          )
          .pipe(
            Effect.as({ type: "created" } as const),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") return projected.session
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      fork: Effect.fn("Session.fork")(function* (input) {
        const parent = yield* result.get(input.sessionID)
        const boundary = yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, input.sessionID),
              input.before ? eq(SessionMessageTable.id, input.before) : undefined,
            ),
          )
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (!boundary && input.before)
          return yield* new MessageNotFoundError({
            sessionID: input.sessionID,
            messageID: input.before,
          })
        if (!boundary) return yield* new ForkEmptyError({ sessionID: input.sessionID })
        const sessionID = SessionSchema.ID.create()
        const inherited = yield* db
          .transaction(() =>
            Effect.all({
              instructions: InstructionState.current(db, parent.id),
              instructionEntries: InstructionEntry.snapshot(db, parent.id),
            }),
          )
          .pipe(Effect.orDie)
        // The fork adopts the parent's newest instruction values rather than the
        // values in effect at the boundary; copied history may contain frozen
        // instruction-update text the initial baseline already reflects.
        yield* bus.publish(SessionEvent.Forked, {
          sessionID,
          parentID: parent.id,
          boundary: { type: input.before ? "before" : "through", messageID: boundary.id },
          ...inherited,
        })
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      get: Effect.fn("Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      environment: Effect.fn("Session.environment")(function* (input) {
        yield* result.get(input.sessionID)
        if (input.variables !== undefined) yield* environments.set(input.sessionID, input.variables)
        return yield* environments.get(input.sessionID)
      }),
      view: Effect.fn("Session.view")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (
          session.time.idle === undefined ||
          input.idle > DateTime.toEpochMillis(session.time.idle) ||
          (session.time.viewed !== undefined && DateTime.toEpochMillis(session.time.viewed) >= input.idle)
        )
          return
        yield* bus.publish(SessionEvent.Viewed, { sessionID: input.sessionID, idle: input.idle })
      }),
      remove: Effect.fn("Session.remove")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.interrupt(sessionID)
        yield* execution.awaitIdle(sessionID)
        yield* transport.close(sessionID)
        const children = yield* result.list({ parentID: sessionID })
        yield* Effect.forEach(children.data, (child) => result.remove(child.id), { concurrency: 1, discard: true })
        yield* environments.clear(sessionID)
        yield* bus.publish(SessionEvent.Deleted, { sessionID })
        yield* bus.remove(sessionID)
      }),
      list: Effect.fn("Session.list")(function* (input) {
        return { data: yield* store.list(input) }
      }),
      messages: Effect.fn("Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* store.messages(input)
      }),
      message: Effect.fn("Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      diff: Effect.fn("Session.diff")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const active = yield* execution.isActive(input.sessionID)
        return yield* SessionDiff.turn(db, locations, {
          session,
          active,
          from: input.from,
          to: input.to,
          context: input.context,
        })
      }),
      inbox: Effect.fn("Session.inbox")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* admission.list(sessionID)
      }),
      cancelInbox: Effect.fn("Session.cancelInbox")(
        (input) => mutatePending(input, admission.cancel),
        Effect.uninterruptible,
      ),
      steerInbox: Effect.fn("Session.steerInbox")(function* (input) {
        yield* mutatePending(input, admission.steer)
        yield* execution.wake(input.sessionID)
      }, Effect.uninterruptible),
      queueInbox: Effect.fn("Session.queueInbox")(
        (input) => mutatePending(input, admission.queue),
        Effect.uninterruptible,
      ),
      log: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(bus.log({ aggregateID: input.sessionID, after: input.after, follow: input.follow }))),
        ).pipe(
          Stream.filter(
            (item): item is SessionEvent.DurableEvent | EventLog.Synced =>
              Bus.isSynced(item) || isDurableSessionEvent(item),
          ),
        ),
      prompt: Effect.fn("Session.prompt")((input) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const session = yield* result.get(input.sessionID)
            const messageID = input.id ?? SessionMessage.ID.create()
            const admitted = yield* Effect.gen(function* () {
              const existing = yield* admission.reconcile({
                id: messageID,
                sessionID: session.id,
                type: "user",
                delivery: input.delivery ?? "steer",
              })
              if (existing) return existing
              const item = yield* restore(
                SessionPrompt.prepare({ session, messageID, input }).pipe(
                  Effect.provideService(Instance.Service, instances),
                  Effect.provideService(FSUtil.Service, fs),
                ),
              )
              // Commit a staged revert only after preparation succeeds, before admitting new work.
              if (session.revert) yield* SessionRevert.commit(bus, session)
              return yield* admission.admit({
                id: messageID,
                sessionID: session.id,
                item,
              })
            }).pipe(
              Effect.catchTag(
                "SessionInbox.LifecycleConflict",
                () => new PromptConflictError({ sessionID: input.sessionID, messageID }),
              ),
            )
            if (input.resume !== false) yield* execution.wake(input.sessionID)
            return admitted
          }),
        ),
      ),
      generate: Effect.fn("Session.generate")(function* (input) {
        const session = yield* result.get(input.sessionID)
        return yield* SessionGenerate.generate({ session, prompt: input.prompt }).pipe(
          Effect.provideService(Instance.Service, instances),
          Effect.provideService(Database.Service, database),
          Effect.provideService(LLMClient.Service, llm),
        )
      }),
      command: Effect.fn("Session.command")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const commands = yield* Plugin.awaitActivation.pipe(Effect.andThen(Command.Service), instances.provide(session))
        yield* commands.execute({
          name: input.command,
          invocation: {
            sessionID: session.id,
            prompt: {
              text: input.text,
              files: input.files,
              agents: input.agents,
              skills: input.skills,
            },
            delivery: input.delivery ?? "steer",
          },
        })
      }),
      shell: Effect.fn("Session.shell")(function* (input) {
        const session = yield* result.get(input.sessionID)
        // The server owns completion recording even if the submitting client disconnects.
        const running = yield* Effect.gen(function* () {
          const started = yield* Effect.gen(function* () {
            const shells = yield* Plugin.awaitActivation.pipe(Effect.andThen(Shell.Service), instances.provide(session))
            const info = yield* shells.create({
              command: input.command,
              cwd: session.location.directory,
              timeout: 0,
              metadata: { sessionID: session.id, background: true },
            })
            return { shells, info }
          }).pipe(
            Effect.tapError((error) =>
              result.synthetic({
                sessionID: input.sessionID,
                text: `User shell command failed to start:\n${input.command}\n\n${error.message}`,
                description: input.command,
                metadata: { source: "shell", state: "error" },
                resume: false,
              }),
            ),
            Effect.orDie,
          )
          yield* bus.publish(
            SessionEvent.Shell.Started,
            {
              sessionID: input.sessionID,
              shell: started.info,
            },
            { id: input.id ? Event.ID.make(input.id.replace(/^msg_/, "evt_")) : undefined },
          )
          // Keep completion tied to the original shell even if the Session moves.
          const terminal = yield* started.shells.result(started.info)
          const preview = yield* started.shells
            .output(started.info.id, { limit: 1024 * 1024 })
            .pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(ShellResult.unavailable)))
          yield* bus.publish(SessionEvent.Shell.Ended, {
            sessionID: input.sessionID,
            shell: terminal.info,
            output: preview,
          })
          yield* result
            .synthetic({
              sessionID: input.sessionID,
              ...ShellResult.userNotification(terminal),
              resume: false,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", () => Effect.void),
              Effect.orDie,
            )
        }).pipe(Effect.forkIn(scope, { startImmediately: true }))
        yield* Fiber.join(running)
      }),
      skill: Effect.fn("Session.skill")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const skills = yield* Plugin.awaitActivation.pipe(Effect.andThen(Skill.Service), instances.provide(session))
        const skill = yield* skills.get(input.skill)
        if (!skill) return yield* new SkillNotFoundError({ skill: input.skill })
        yield* bus.publish(
          SessionEvent.Skill.Activated,
          {
            sessionID: input.sessionID,
            id: skill.id,
            name: skill.name,
            text: skill.content,
          },
          { id: input.messageID ? Event.ID.make(input.messageID.replace(/^msg_/, "evt_")) : undefined },
        )
        if (input.resume !== false)
          yield* execution
            .resume(input.sessionID)
            .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
      }),
      switchAgent: Effect.fn("Session.switchAgent")(function* (input) {
        const session = yield* result.get(input.sessionID)
        yield* bus.publish(SessionEvent.AgentSelected, {
          sessionID: input.sessionID,
          agent: input.agent,
          previous: session.agent,
        })
      }),
      switchModel: Effect.fn("Session.switchModel")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (
          session.model?.providerID === input.model.providerID &&
          session.model.id === input.model.id &&
          (session.model.variant ?? "default") === (input.model.variant ?? "default")
        )
          return
        yield* bus.publish(SessionEvent.ModelSelected, {
          sessionID: input.sessionID,
          model: input.model,
          previous: session.model,
        })
      }),
      rename: Effect.fn("Session.rename")(function* (input) {
        yield* result.get(input.sessionID)
        yield* bus.publish(SessionEvent.Renamed, { sessionID: input.sessionID, title: input.title })
      }),
      setMetadata: Effect.fn("Session.setMetadata")(function* (input) {
        yield* result.get(input.sessionID)
        yield* bus.publish(SessionEvent.MetadataUpdated, { sessionID: input.sessionID, metadata: input.metadata })
      }),
      setPermissions: Effect.fn("Session.setPermissions")(function* (input) {
        yield* result.get(input.sessionID)
        yield* bus.publish(SessionEvent.Permissions, { sessionID: input.sessionID, permissions: input.permissions })
      }),
      move: moves.move,
      compact: Effect.fn("Session.compact")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (session.revert) yield* SessionRevert.commit(bus, session)
        const inputID = input.id ?? SessionMessage.ID.create()
        const admitted = yield* admission
          .admitCompaction({
            id: inputID,
            sessionID: input.sessionID,
            delivery: input.delivery ?? "steer",
          })
          .pipe(
            Effect.catchTag(
              "SessionInbox.LifecycleConflict",
              () => new CompactionConflictError({ sessionID: input.sessionID, inputID }),
            ),
          )
        yield* execution.wake(input.sessionID)
        return admitted
      }),
      wait: Effect.fn("Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.awaitIdle(sessionID)
      }),
      active: execution.active,
      background: Effect.fn("Session.background")(function* (sessionID) {
        yield* result.get(sessionID)
        const backgrounded = yield* jobs.backgroundAll({ sessionID })
        if (backgrounded.length === 0) return
        yield* result
          .synthetic({
            sessionID,
            text: [
              "User requested that active blocking work be moved to the background.",
              "",
              "Backgrounded work:",
              ...backgrounded.map((job) => `- ${job.type}: ${job.title && job.title.length > 0 ? job.title : job.id}`),
              "",
              "The backgrounded work is still unfinished. Move on to other work if you can. If there is nothing else useful to do, finish your response. Do not wait, sleep, poll, or report the backgrounded work as complete until a later completion notification is added to the conversation.",
            ].join("\n"),
          })
          .pipe(Effect.catchTag("Session.SyntheticConflictError", Effect.die))
      }),
      resume: Effect.fn("Session.resume")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.resume(sessionID)
      }),
      synthetic: Effect.fn("Session.synthetic")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* result.get(input.sessionID)
            const inputID = input.id ?? SessionMessage.ID.create()
            const item = {
              type: "synthetic",
              payload: SessionInbox.SyntheticPayload.make({
                text: input.text,
                description: input.description,
                metadata: input.metadata,
              }),
              delivery: SessionInbox.Delivery.make(input.delivery ?? "steer"),
            } satisfies SessionInbox.Item
            const admitted = yield* admission
              .admit({
                id: inputID,
                sessionID: input.sessionID,
                item,
              })
              .pipe(
                Effect.catchTag(
                  "SessionInbox.LifecycleConflict",
                  () => new SyntheticConflictError({ sessionID: input.sessionID, inputID }),
                ),
              )
            if (input.resume !== false && !(yield* result.get(input.sessionID)).revert)
              yield* execution.wake(input.sessionID)
            return admitted
          }),
        ),
      ),
      interrupt: Effect.fn("Session.interrupt")((sessionID, options) =>
        Effect.uninterruptible(execution.interrupt(sessionID, options)),
      ),
      revert: {
        stage: Effect.fn("Session.revert.stage")(function* (input) {
          const session = yield* result.get(input.sessionID)
          if (yield* execution.isActive(input.sessionID)) return yield* new BusyError({ sessionID: input.sessionID })
          return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
            Effect.provideService(Instance.Service, instances),
            Effect.provideService(Database.Service, database),
            Effect.provideService(Bus.Service, bus),
          )
        }),
        clear: Effect.fn("Session.revert.clear")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
          yield* SessionRevert.clear(session).pipe(
            Effect.provideService(Instance.Service, instances),
            Effect.provideService(Bus.Service, bus),
          )
          return yield* execution.wake(sessionID)
        }),
        commit: Effect.fn("Session.revert.commit")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
          return yield* SessionRevert.commit(bus, session)
        }),
      },
    })

    return result
  }),
)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Job.node,
    SessionEnvironment.node,
    Database.node,
    Bus.node,
    Project.node,
    SessionExecution.node,
    SessionModelTransport.node,
    llmClient,
    SessionStore.node,
    Instance.node,
    SessionInbox.node,
    SessionMove.node,
    SessionProjector.node,
    LocationServiceMap.node,
    FSUtil.node,
    App.node,
  ],
})
