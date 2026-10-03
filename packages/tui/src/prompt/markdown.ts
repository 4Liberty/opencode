import {
  parseUserMarkdownInline,
  userMarkdownLines,
  type UserMarkdownInline,
  type UserMarkdownLine,
  type UserMarkdownMention,
} from "@opencode/util/user-markdown"
import { displayOffsets } from "./display"

export type PromptMarkdownStyle =
  | "marker"
  | "list"
  | "quote"
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "code-block"
  | "link"

/** A styled prompt range in textarea display offsets. Deeper ranges draw over the ranges that contain them. */
export type PromptMarkdownRange = { start: number; end: number; style: PromptMarkdownStyle; depth: number }

type Range = { start: number; end: number }

/** Slack-style Markdown ranges for live prompt styling. Markers stay in the text and get their own style. */
export function promptMarkdownRanges(text: string, mentions: readonly Range[] = []): PromptMarkdownRange[] {
  const offsets = displayOffsets(text)
  // Mentions arrive in display offsets; the parser works on string indices.
  const indices = new Map(offsets.map((offset, index) => [offset, index] as const).reverse())
  const atoms = mentions.flatMap((mention): UserMarkdownMention[] => {
    const start = indices.get(mention.start)
    const end = indices.get(mention.end)
    return start === undefined || end === undefined ? [] : [{ start, end, type: "file" }]
  })
  const lines = userMarkdownLines(text)
  const fences = new Map<number, UserMarkdownLine>()
  lines.reduce(
    (open, line) => {
      if (line.kind !== "fence") return open
      if (!open) return line
      fences.set(open.start, line)
      return undefined
    },
    undefined as UserMarkdownLine | undefined,
  )
  return lines
    .flatMap((line) => lineRanges(text, line, fences.get(line.start), atoms))
    .flatMap((range) => withoutMentions(range, atoms))
    .map((range) => ({ ...range, start: offsets[range.start]!, end: offsets[range.end]! }))
}

/** The textarea edit for a newline in a list item: start the next item, or end the list on an empty item. */
export function promptListNewline(text: string, offset: number) {
  const item = listItem(text, offset)
  if (!item) return
  if (!text.slice(item.line.content, item.line.end).trim()) {
    return { start: item.offsets[item.line.start]!, end: item.offsets[item.line.end]!, text: "" }
  }
  const prefix = text.slice(item.line.start, item.line.content).trimEnd()
  const next = item.line.kind === "ordered" ? prefix.replace(/\d+/, String(item.line.value + 1)) : prefix
  return { start: offset, end: offset, text: `\n${next} ` }
}

/** The list marker that Backspace removes when the cursor is at the start of the item content. */
export function promptListMarker(text: string, offset: number) {
  const item = listItem(text, offset)
  if (!item || item.index !== item.line.content) return
  return { start: item.offsets[item.line.start]!, end: item.offsets[item.line.content]! }
}

function lineRanges(
  text: string,
  line: UserMarkdownLine,
  close: UserMarkdownLine | undefined,
  mentions: UserMarkdownMention[],
): PromptMarkdownRange[] {
  if (close) {
    return [
      { start: line.start, end: close.end, style: "code-block", depth: 0 },
      { start: line.start, end: line.end, style: "marker", depth: 1 },
      { start: close.start, end: close.end, style: "marker", depth: 1 },
    ]
  }
  if (line.kind === "fence" || line.kind === "code") return []
  const quote = line.kind === "quote"
  const inline = inlineRanges(parseUserMarkdownInline(text, line.content, line.end, mentions), quote ? 1 : 0)
  if (quote) {
    return [
      { start: line.start, end: line.end, style: "quote", depth: 0 },
      { start: line.start, end: line.content, style: "marker", depth: 1 },
      ...inline,
    ]
  }
  if (line.kind === "bullet" || line.kind === "ordered") {
    return [{ start: line.start, end: line.content, style: "list", depth: 0 }, ...inline]
  }
  return inline
}

function inlineRanges(nodes: UserMarkdownInline[], depth: number): PromptMarkdownRange[] {
  return nodes.flatMap((node): PromptMarkdownRange[] => {
    if (node.type === "text" || node.type === "mention") return []
    if (node.type === "link") return [{ start: node.start, end: node.end, style: "link", depth }]
    return [
      { start: node.start, end: node.end, style: node.type, depth },
      { start: node.start, end: node.start + node.marker, style: "marker", depth: depth + 1 },
      ...(node.type === "code" ? [] : inlineRanges(node.children, depth + 1)),
      { start: node.end - node.marker, end: node.end, style: "marker", depth: depth + 1 },
    ]
  })
}

// Mentions keep their own style, so Markdown ranges skip over them.
function withoutMentions(range: PromptMarkdownRange, mentions: Range[]) {
  return mentions.reduce(
    (parts, mention) =>
      parts.flatMap((part) => {
        if (mention.end <= part.start || mention.start >= part.end) return [part]
        return [
          ...(part.start < mention.start ? [{ ...part, end: mention.start }] : []),
          ...(mention.end < part.end ? [{ ...part, start: mention.end }] : []),
        ]
      }),
    [range],
  )
}

function listItem(text: string, offset: number) {
  const offsets = displayOffsets(text)
  const index = offsets.indexOf(offset)
  if (index < 0) return
  const line = userMarkdownLines(text).find((entry) => entry.start <= index && index <= entry.end)
  if (!line || (line.kind !== "bullet" && line.kind !== "ordered") || index < line.content) return
  return { line, index, offsets }
}
