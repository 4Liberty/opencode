import type { SessionInboxInfo, SessionMessageInfo, SessionMessageUser } from "@opencode/client/promise"

export function applyTimelineMessageHandoff(messages: SessionMessageInfo[], handoff?: SessionMessageUser) {
  if (!handoff) return messages
  const index = messages.findIndex((message) => message.id === handoff.id)
  if (index < 0) return [...messages, handoff]
  const message = messages[index]
  if (message.type !== "user" || message.files?.length) return messages
  return messages.map((item, current) => (current === index ? { ...message, files: handoff.files } : item))
}

export function visibleTimelineMessages(
  messages: SessionMessageInfo[],
  pending: SessionInboxInfo[],
  revertMessageID?: string,
) {
  const queued = new Set(
    pending.flatMap((item) => (item.type === "user" && item.delivery === "queue" ? [item.id] : [])),
  )
  const steers = new Set(
    pending.flatMap((item) => (item.type === "user" && item.delivery === "steer" ? [item.id] : [])),
  )
  const notices = new Set(pending.flatMap((item) => (item.type === "synthetic" ? [item.id] : [])))
  if (queued.size === 0 && steers.size === 0 && notices.size === 0 && !revertMessageID) return messages
  const visible = messages.filter(
    (message) => !queued.has(message.id) && (!revertMessageID || message.id < revertMessageID),
  )
  if (steers.size === 0 && notices.size === 0) return visible
  // Undelivered inputs do not own assistant work, so they stay below the active work like the TUI.
  // Notices precede steers so they stay in the active turn instead of joining an undelivered one.
  return [
    ...visible.filter((message) => !steers.has(message.id) && !notices.has(message.id)),
    ...visible.filter((message) => notices.has(message.id)),
    ...visible.filter((message) => steers.has(message.id)),
  ]
}

export function timelineChildTitle(input: {
  parentID?: string
  taskDescription?: string
  title?: string
  fallback: string
}) {
  if (!input.parentID) return input.title ?? ""
  if (input.taskDescription) return input.taskDescription
  return input.title?.replace(/\s+\(@[^)]+ subagent\)$/, "") || input.fallback
}
