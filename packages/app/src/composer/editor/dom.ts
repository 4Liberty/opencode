import { Skill } from "@opencode/schema/skill"
import {
  parseUserMarkdownInline,
  userMarkdownLines,
  type UserMarkdownInline,
  type UserMarkdownLine,
  type UserMarkdownMention,
} from "@opencode/util/user-markdown"
import { isAttachment } from "../prompt-parts"
import type { ComposerAttachment, ComposerPrompt } from "../types"

type EditorPart = Exclude<ComposerPrompt[number], ComposerAttachment>
type MentionPart = Exclude<EditorPart, { type: "text" }>
type LineKind = "text" | "bullet" | "ordered"
type ComposerLine = ReturnType<typeof composerLines>[number]
// Text segments map characters one to one. Mentions and breaks are atomic. Blocks mark where empty content starts.
type Segment = { node: Node; start: number; length: number; kind: "text" | "atom" | "block" }
// A styled span over prompt text. Markers stay in the text so the editor and the prompt keep the same characters.
type Decoration = { kind: string; start: number; end: number; children: Decoration[] }

const ZERO_WIDTH = /\u200B/g
const BLOCKS = new Set(["DIV", "P", "LI"])
const mentionParts = new WeakMap<HTMLElement, MentionPart>()

/**
 * Replaces the editor content with the prompt text and mentions. With `markdown`, `- ` and `1. ` lines render as
 * list items whose markers exist only in the prompt text, and inline styles render with their markers dimmed.
 */
export function renderComposerEditor(editor: HTMLElement, prompt: ComposerPrompt, markdown: boolean) {
  const parts = prompt.filter((part): part is EditorPart => !isAttachment(part))
  const text = parts.map((part) => part.content).join("")
  const lines = composerLines(text, parts, markdown)
  const nodes: Node[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    let end = index + 1
    while (end < lines.length && continues(lines[end - 1]!, lines[end]!)) end++
    if (line.kind === "text") {
      // The newline before a list stays in the text; the newline after a list belongs to the list.
      const stop = end < lines.length ? lines[end]!.start : text.length
      const decorations = lines.slice(index, end).flatMap((entry) => entry.decorations)
      if (line.start < stop) nodes.push(...build(parts, line.start, stop, decorations))
      else if (index > 0) nodes.push(emptyBlock("div"))
      index = end
      continue
    }
    const list = document.createElement(line.kind === "ordered" ? "ol" : "ul")
    if (list instanceof HTMLOListElement && line.value !== 1) list.start = line.value
    list.append(
      ...lines.slice(index, end).map((item) => {
        const content = build(parts, item.content, item.end, item.decorations)
        if (content.length === 0) return emptyBlock("li")
        const element = document.createElement("li")
        element.append(...content)
        return element
      }),
    )
    nodes.push(list)
    index = end
  }
  editor.replaceChildren(...nodes)
}

/**
 * Reads the prompt and caret from the editor. `stale` means the editor shows different lists or styles than the
 * prompt text describes, for example right after the user types `- ` at the start of a line or closes `*bold*`.
 */
export function readComposerEditor(editor: HTMLElement, markdown: boolean) {
  const result = walk(editor, selectionPoint(editor))
  const cursor = Math.min(result.cursor ?? result.text.length, result.text.length)
  const lineStart = result.text.lastIndexOf("\n", cursor - 1) + 1
  // Slack also turns `* ` and `• ` into bullets; the prompt keeps the `- ` marker.
  const shortcut =
    markdown &&
    cursor === lineStart + 2 &&
    /^[*•] $/.test(result.text.slice(lineStart, cursor)) &&
    result.lines[result.text.slice(0, lineStart).split("\n").length - 1] === "text"
  const parts = shortcut ? replaceCharacter(result.parts, lineStart, "-") : result.parts
  const text = shortcut ? `${result.text.slice(0, lineStart)}-${result.text.slice(lineStart + 1)}` : result.text
  const expected = composerLines(text, parts, markdown)
  const empty = parts.every((part) => part.type === "text" && !part.content.replace(/\n/g, ""))
  return {
    prompt: empty ? [{ type: "text" as const, content: "", start: 0, end: 0 }] : parts,
    cursor: empty ? 0 : cursor,
    stale:
      expected.length !== result.lines.length ||
      expected.some((entry, index) => entry.kind !== result.lines[index]) ||
      signature(expected.flatMap((entry) => entry.decorations)).join() !== result.styles.join(),
  }
}

export function getCursorPosition(parent: HTMLElement): number {
  return walk(parent, selectionPoint(parent)).cursor ?? 0
}

export function setCursorPosition(parent: HTMLElement, position: number) {
  const segments = walk(parent).segments
  const candidates = segments.filter(
    (segment) => segment.start <= position && position <= segment.start + segment.length,
  )
  // At a style edge, prefer the least styled text so typing beside `*bold*` stays outside it.
  const target =
    candidates
      .filter((segment) => segment.kind === "text")
      .sort((a, b) => styleDepth(parent, a.node) - styleDepth(parent, b.node))[0] ?? candidates[0]
  const next = target ? undefined : segments.find((segment) => segment.start > position)
  const range = document.createRange()
  if (target) place(range, target, position - target.start)
  if (next) place(range, next, 0)
  if (!target && !next) range.selectNodeContents(parent)
  range.collapse(!!(target || next))
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/** Applies Slack list editing: Shift+Enter adds an item, and Backspace at the start of an item removes its bullet. */
export function editComposerList(editor: HTMLElement, event: KeyboardEvent) {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return false
  if (!(event.key === "Enter" && event.shiftKey) && !(event.key === "Backspace" && !event.shiftKey)) return false
  const selection = window.getSelection()
  if (!selection?.rangeCount || !selection.isCollapsed) return false
  const range = selection.getRangeAt(0)
  const container = range.startContainer
  const item = (container instanceof Element ? container : container.parentElement)?.closest("li")
  if (!item || !editor.contains(item)) return false
  if (event.key === "Enter") return document.execCommand("insertParagraph")
  const before = document.createRange()
  before.setStart(item, 0)
  before.setEnd(container, range.startOffset)
  if (before.toString().replace(ZERO_WIDTH, "")) return false
  return document.execCommand("outdent")
}

function composerLines(text: string, parts: EditorPart[], markdown: boolean) {
  const lines = userMarkdownLines(text)
  const mentions = markdown ? mentionRanges(parts) : []
  const fences = new Map<number, number>()
  lines.reduce((open, line, index) => {
    if (line.kind !== "fence") return open
    if (open < 0) return index
    fences.set(open, index)
    return -1
  }, -1)
  return lines.map((line, index) => {
    // Only the markers the editor writes back render as lists, so rendering never rewrites the prompt text.
    const marker = line.kind === "ordered" ? `${line.value}. ` : "- "
    const kind: LineKind =
      markdown && (line.kind === "bullet" || line.kind === "ordered") && text.startsWith(marker, line.start)
        ? line.kind
        : "text"
    const content = line.start + (kind === "text" ? 0 : marker.length)
    const decorations = markdown ? lineDecorations(text, line, content, lines[fences.get(index) ?? -1], mentions) : []
    return { kind, start: line.start, end: line.end, content, value: line.value, decorations }
  })
}

function lineDecorations(
  text: string,
  line: UserMarkdownLine,
  content: number,
  close: UserMarkdownLine | undefined,
  mentions: UserMarkdownMention[],
) {
  if (close) {
    return [
      styled("code-block", line.start, close.end, [
        markerSpan(line.start, line.end),
        markerSpan(close.start, close.end),
      ]),
    ]
  }
  if (line.kind === "fence" || line.kind === "code") return []
  const start = line.kind === "quote" ? line.content : content
  const inline = inlineDecorations(parseUserMarkdownInline(text, start, line.end, mentions))
  if (line.kind !== "quote") return inline
  return [styled("quote", line.start, line.end, [markerSpan(line.start, line.content), ...inline])]
}

function inlineDecorations(nodes: UserMarkdownInline[]): Decoration[] {
  return nodes.flatMap((node) => {
    if (node.type === "text" || node.type === "mention") return []
    if (node.type === "link") return [styled("link", node.start, node.end, [])]
    return [
      styled(node.type, node.start, node.end, [
        markerSpan(node.start, node.start + node.marker),
        ...(node.type === "code" ? [] : inlineDecorations(node.children)),
        markerSpan(node.end - node.marker, node.end),
      ]),
    ]
  })
}

function styled(kind: string, start: number, end: number, children: Decoration[]): Decoration {
  return { kind, start, end, children }
}

function markerSpan(start: number, end: number) {
  return styled("marker", start, end, [])
}

function signature(decorations: Decoration[]): string[] {
  return decorations.flatMap((decoration) => [
    `${decoration.kind}:${decoration.start}-${decoration.end}`,
    ...signature(decoration.children),
  ])
}

function mentionRanges(parts: EditorPart[]) {
  let offset = 0
  return parts.flatMap((part): UserMarkdownMention[] => {
    const start = offset
    offset += part.content.length
    return part.type === "text" ? [] : [{ start, end: offset, type: part.type === "agent" ? "agent" : "file" }]
  })
}

function styleDepth(root: HTMLElement, node: Node) {
  let depth = 0
  for (let element = node.parentElement; element && element !== root; element = element.parentElement) {
    if (element.dataset.md) depth++
  }
  return depth
}

function continues(previous: ComposerLine, line: ComposerLine) {
  if (previous.kind !== line.kind) return false
  return line.kind !== "ordered" || line.value === previous.value + 1
}

function walk(root: HTMLElement, point?: { node: Node; offset: number }) {
  const parts: EditorPart[] = []
  const segments: Segment[] = []
  // The kind of each prompt line as the editor shows it. Lines inside an item after its first line are continuations.
  const lines: (LineKind | "continuation")[] = ["text"]
  // Styled spans in document order, in the same form as `signature`.
  const styles: string[] = []
  let text = ""
  let buffer = ""
  // A block ends its last line without a newline; the next inline content owes one.
  let owed = false
  let item: LineKind | undefined
  let cursor: number | undefined

  const write = (value: string) => {
    text += value
    buffer += value
    for (const char of value) if (char === "\n") lines.push(item ? "continuation" : "text")
  }
  const settle = () => {
    if (!owed) return
    owed = false
    write("\n")
  }
  const flush = () => {
    if (buffer) parts.push({ type: "text", content: buffer, start: text.length - buffer.length, end: text.length })
    buffer = ""
  }
  const position = () => text.length + (owed ? 1 : 0)
  const children = (element: Node) => {
    const nodes = Array.from(element.childNodes)
    nodes.forEach((child, index) => {
      if (point?.node === element && point.offset === index) cursor ??= position()
      visit(child)
    })
    if (point?.node === element && point.offset >= nodes.length) cursor ??= position()
  }
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = node.textContent ?? ""
      if (point?.node === node) cursor ??= position() + data.slice(0, point.offset).replace(ZERO_WIDTH, "").length
      const value = data.replace(ZERO_WIDTH, "")
      if (!value) return
      settle()
      segments.push({ node, start: text.length, length: value.length, kind: "text" })
      write(value)
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.dataset.mention) {
      settle()
      flush()
      const part = mentionPart(node, text.length)
      segments.push({ node, start: text.length, length: part.content.length, kind: "atom" })
      parts.push(part)
      text += part.content
      return
    }
    if (node.dataset.md) {
      const slot = styles.push("") - 1
      const start = position()
      children(node)
      styles[slot] = `${node.dataset.md}:${start}-${text.length}`
      return
    }
    if (node.tagName === "BR") {
      if (placeholder(node)) return
      settle()
      segments.push({ node, start: text.length, length: 1, kind: "atom" })
      write("\n")
      return
    }
    if (!BLOCKS.has(node.tagName)) {
      children(node)
      return
    }
    const after = owed
    owed = false
    if (after || (text && !text.endsWith("\n"))) write("\n")
    const kind = node.tagName !== "LI" ? undefined : node.parentElement?.tagName === "OL" ? "ordered" : "bullet"
    if (kind) {
      lines[lines.length - 1] = kind
      write(kind === "ordered" ? `${ordinal(node)}. ` : "- ")
      item = kind
    }
    segments.push({ node, start: text.length, length: 0, kind: "block" })
    children(node)
    if (kind) item = undefined
    owed = true
  }

  children(root)
  flush()
  return { parts, segments, lines, styles, text, cursor }
}

function selectionPoint(editor: HTMLElement) {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return
  const range = selection.getRangeAt(0)
  if (!editor.contains(range.startContainer)) return
  return { node: range.startContainer, offset: range.startOffset }
}

function place(range: Range, segment: Segment, offset: number) {
  if (segment.kind === "text") {
    range.setStart(segment.node, domOffset(segment.node.textContent ?? "", offset))
    return
  }
  if (segment.kind === "block") {
    range.setStart(segment.node, 0)
    return
  }
  if (offset > 0) range.setStartAfter(segment.node)
  else range.setStartBefore(segment.node)
}

function domOffset(data: string, visible: number) {
  let count = 0
  for (let index = 0; index < data.length; index++) {
    if (count >= visible) return index
    if (data[index] !== "\u200B") count++
  }
  return data.length
}

// A trailing break only gives an empty block its height; it does not start a line.
function placeholder(node: HTMLElement) {
  let next = node.nextSibling
  while (next?.nodeType === Node.TEXT_NODE && !(next.textContent ?? "").replace(ZERO_WIDTH, "")) next = next.nextSibling
  return !next && BLOCKS.has(node.parentElement?.tagName ?? "")
}

function ordinal(item: HTMLElement) {
  const list = item.parentElement
  const start = list instanceof HTMLOListElement ? list.start : 1
  return (
    start +
    Array.from(list?.children ?? [])
      .filter((child) => child.tagName === "LI")
      .indexOf(item)
  )
}

function emptyBlock(tag: "div" | "li") {
  const element = document.createElement(tag)
  element.append(document.createElement("br"))
  return element
}

function replaceCharacter(parts: EditorPart[], position: number, value: string) {
  return parts.map((part) => {
    if (part.type !== "text" || position < part.start || position >= part.end) return part
    const offset = position - part.start
    return { ...part, content: part.content.slice(0, offset) + value + part.content.slice(offset + 1) }
  })
}

function build(parts: EditorPart[], start: number, end: number, decorations: Decoration[]): Node[] {
  let at = start
  const nodes = decorations.flatMap((decoration) => {
    const before = fill(parts, at, decoration.start)
    const element = document.createElement("span")
    element.dataset.md = decoration.kind
    element.append(...build(parts, decoration.start, decoration.end, decoration.children))
    at = decoration.end
    return [...before, element]
  })
  return [...nodes, ...fill(parts, at, end)]
}

function fill(parts: EditorPart[], start: number, end: number) {
  let offset = 0
  return parts.flatMap<Node>((part) => {
    const from = offset
    offset += part.content.length
    if (part.type !== "text") return from >= start && from < end ? [mentionElement(part)] : []
    const value = part.content.slice(Math.max(0, start - from), Math.max(0, end - from))
    return value ? [document.createTextNode(value)] : []
  })
}

function mentionElement(part: MentionPart) {
  const mention = document.createElement("span")
  mentionParts.set(mention, part)
  mention.textContent = part.content
  mention.contentEditable = "false"
  mention.dir = "auto"
  mention.style.unicodeBidi = "isolate"
  mention.dataset.mention = part.type === "file" && part.mime === "application/x-directory" ? "reference" : part.type
  if (part.type === "agent") mention.dataset.name = part.name
  if (part.type === "skill") {
    mention.dataset.id = part.id
    mention.dataset.name = part.name
  }
  if (part.type === "file") {
    mention.dataset.path = part.path
    if (part.mime) mention.dataset.mime = part.mime
    if (part.filename) mention.dataset.filename = part.filename
  }
  return mention
}

function mentionPart(element: HTMLElement, start: number): MentionPart {
  const content = element.textContent ?? ""
  const original = mentionParts.get(element)
  const end = start + content.length
  if (element.dataset.mention === "agent") {
    return {
      ...(original?.type === "agent" ? original : {}),
      type: "agent",
      name: element.dataset.name ?? content.slice(1),
      content,
      start,
      end,
    }
  }
  if (element.dataset.mention === "skill") {
    return {
      ...(original?.type === "skill" ? original : {}),
      type: "skill",
      id: Skill.ID.make(element.dataset.id ?? content.slice(1)),
      name: Skill.Name.make(element.dataset.name ?? content.slice(1)),
      content,
      start,
      end,
    }
  }
  return {
    ...(original?.type === "file" ? original : {}),
    type: "file",
    path: element.dataset.path ?? content.slice(1),
    content,
    start,
    end,
    ...(element.dataset.mime ? { mime: element.dataset.mime } : {}),
    ...(element.dataset.filename ? { filename: element.dataset.filename } : {}),
  }
}
