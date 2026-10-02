export * as SessionErrors from "./error.js"

import { Schema } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Skill } from "@opencode/schema/skill"
import { SessionMessage } from "@opencode/schema/session-message"
import { Session } from "@opencode/schema/session"
import { SessionError } from "@opencode/schema/session-error"

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Session.NotFoundError", {
  sessionID: Session.ID,
}) {}

export class MessageNotFoundError extends Schema.TaggedError<MessageNotFoundError>()("Session.MessageNotFoundError", {
  sessionID: Session.ID,
  messageID: SessionMessage.ID,
}) {}

export class ForkEmptyError extends Schema.TaggedError<ForkEmptyError>()("Session.ForkEmptyError", {
  sessionID: Session.ID,
}) {
  override get message() {
    return `Cannot fork empty session: ${this.sessionID}`
  }
}

export class MessageDecodeError extends Schema.TaggedError<MessageDecodeError>()("Session.MessageDecodeError", {
  sessionID: Session.ID,
  messageID: SessionMessage.ID,
}) {
  override get message() {
    return `Failed to decode message ${this.messageID} in session ${this.sessionID}`
  }
}

export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()("Session.AgentNotFoundError", {
  sessionID: Session.ID,
  agent: Agent.ID,
}) {
  override get message() {
    return `Agent not found: "${this.agent}"`
  }
}

export class StepFailedError extends Schema.TaggedError<StepFailedError>()("Session.StepFailedError", {
  error: SessionError.Error,
}) {
  override get message() {
    return this.error.message
  }
}

export class PromptConflictError extends Schema.TaggedError<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: Session.ID,
  messageID: SessionMessage.ID,
}) {}

export class SyntheticConflictError extends Schema.TaggedError<SyntheticConflictError>()(
  "Session.SyntheticConflictError",
  {
    sessionID: Session.ID,
    inputID: SessionMessage.ID,
  },
) {}

export class AttachmentError extends Schema.TaggedError<AttachmentError>()("Session.AttachmentError", {
  uri: Schema.String,
  message: Schema.String,
}) {}

export class CompactionConflictError extends Schema.TaggedError<CompactionConflictError>()(
  "Session.CompactionConflictError",
  {
    sessionID: Session.ID,
    inputID: SessionMessage.ID,
  },
) {}

export class BusyError extends Schema.TaggedError<BusyError>()("Session.BusyError", {
  sessionID: Session.ID,
}) {}

export class InboxConflictError extends Schema.TaggedError<InboxConflictError>()("Session.InboxConflictError", {
  sessionID: Session.ID,
  inboxID: SessionMessage.ID,
}) {}

export class SkillNotFoundError extends Schema.TaggedError<SkillNotFoundError>()("Session.SkillNotFoundError", {
  skill: Skill.ID,
}) {}
