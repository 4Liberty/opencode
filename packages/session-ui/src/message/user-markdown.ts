export type UserMarkdownMention = { start: number; end: number; type: "file" | "agent" }

// Styled spans keep their source range, including markers of `marker` characters at each end.
export type UserMarkdownInline =
  | { type: "text"; text: string }
  | { type: "mention"; text: string; mention: UserMarkdownMention["type"] }
  | { type: "code"; text: string; start: number; end: number; marker: number }
  | { type: "link"; text: string; start: number; end: number }
  | { type: "bold" | "italic" | "strike"; children: UserMarkdownInline[]; start: number; end: number; marker: number }

export type UserMarkdownBlock =
  | { type: "paragraph"; children: UserMarkdownInline[] }
  | { type: "quote"; children: UserMarkdownInline[] }
  | { type: "code"; text: string }
  | { type: "list"; ordered: boolean; items: { value: number; children: UserMarkdownInline[] }[] }

export type UserMarkdownLine = {
  kind: "text" | "fence" | "code" | "quote" | "bullet" | "ordered"
  start: number
  end: number
  /** Offset where the line content starts after its quote or list marker. */
  content: number
  value: number
}

const FENCE = /^[ \t]*```/
const FENCE_CLOSE = /^[ \t]*```[ \t]*$/
const QUOTE = /^>[ \t]?/
const BULLET = /^[ \t]*[-*•][ \t]+/
const ORDERED = /^[ \t]*(\d{1,9})\.[ \t]+/
const URL_PATTERN = /^https?:\/\/[^\s<>"'`]+/
const WORD = /[\p{L}\p{N}]/u
const SPACE = /\s/
const MARKS = { "*": "bold", _: "italic", "~": "strike" } as const

/** Slack-style lines: fenced code, quotes, bullets, and numbered items. Unclosed fences stay text. */
export function userMarkdownLines(text: string): UserMarkdownLine[] {
  let offset = 0
  const lines = text.split("\n").map((line) => {
    const start = offset
    offset += line.length + 1
    return { text: line, start, end: start + line.length }
  })
  const result: UserMarkdownLine[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const close = FENCE.test(line.text) ? fenceClose(lines, index) : -1
    if (close < 0) {
      result.push(classify(line))
      continue
    }
    lines.slice(index, close + 1).forEach((code, position, block) =>
      result.push({
        kind: position === 0 || position === block.length - 1 ? "fence" : "code",
        start: code.start,
        end: code.end,
        content: code.start,
        value: 0,
      }),
    )
    index = close
  }
  return result
}

export function parseUserMarkdownInline(
  text: string,
  start: number,
  end: number,
  mentions: UserMarkdownMention[] = [],
): UserMarkdownInline[] {
  return parseInline(text, start, end, new Map(mentions.map((mention) => [mention.start, mention])), "")
}

export function parseUserMarkdown(text: string, mentions: UserMarkdownMention[] = []): UserMarkdownBlock[] {
  const lookup = new Map(mentions.map((mention) => [mention.start, mention]))
  const lines = userMarkdownLines(text)
  const inline = (line: UserMarkdownLine) => parseInline(text, line.content, line.end, lookup, "")
  const joined = (group: UserMarkdownLine[]) =>
    group.flatMap((line, index) => [...(index > 0 ? [{ type: "text" as const, text: "\n" }] : []), ...inline(line)])
  const blocks: UserMarkdownBlock[] = []
  let index = 0
  while (index < lines.length) {
    const kind = lines[index]!.kind
    const end = kind === "fence" ? fenceEnd(lines, index) : groupEnd(lines, index, kind)
    const group = lines.slice(index, end)
    index = end
    if (kind === "fence") {
      const code = group.slice(1, -1)
      blocks.push({ type: "code", text: code.length ? text.slice(code[0]!.start, code.at(-1)!.end) : "" })
      continue
    }
    if (kind === "quote") {
      blocks.push({ type: "quote", children: joined(group) })
      continue
    }
    if (kind === "bullet" || kind === "ordered") {
      blocks.push({
        type: "list",
        ordered: kind === "ordered",
        items: group.map((line) => ({ value: line.value, children: inline(line) })),
      })
      continue
    }
    // A trailing newline at the end of a block does not render, so a blank last line before another block needs one more.
    const children = [
      ...joined(group),
      ...(end < lines.length && group.at(-1)!.start === group.at(-1)!.end
        ? [{ type: "text" as const, text: "\n" }]
        : []),
    ]
    if (children.length) blocks.push({ type: "paragraph", children })
  }
  return blocks
}

function classify(line: { text: string; start: number; end: number }): UserMarkdownLine {
  const quote = QUOTE.exec(line.text)
  if (quote) return { kind: "quote", start: line.start, end: line.end, content: line.start + quote[0].length, value: 0 }
  const bullet = BULLET.exec(line.text)
  if (bullet)
    return { kind: "bullet", start: line.start, end: line.end, content: line.start + bullet[0].length, value: 0 }
  const ordered = ORDERED.exec(line.text)
  if (ordered) {
    return {
      kind: "ordered",
      start: line.start,
      end: line.end,
      content: line.start + ordered[0].length,
      value: Number(ordered[1]),
    }
  }
  return { kind: "text", start: line.start, end: line.end, content: line.start, value: 0 }
}

function fenceClose(lines: { text: string }[], open: number) {
  for (let index = open + 1; index < lines.length; index++) {
    if (FENCE_CLOSE.test(lines[index]!.text)) return index
  }
  return -1
}

function fenceEnd(lines: UserMarkdownLine[], open: number) {
  for (let index = open + 1; index < lines.length; index++) {
    if (lines[index]!.kind === "fence") return index + 1
  }
  return lines.length
}

function groupEnd(lines: UserMarkdownLine[], start: number, kind: UserMarkdownLine["kind"]) {
  let end = start
  while (end < lines.length && lines[end]!.kind === kind) end++
  return end
}

// Marks follow Slack: they open after a non-word character, close before one, and never span lines.
function parseInline(
  text: string,
  start: number,
  end: number,
  mentions: Map<number, UserMarkdownMention>,
  open: string,
): UserMarkdownInline[] {
  const nodes: UserMarkdownInline[] = []
  // Closers do not depend on the opener, so a failed search fails for every later opener of that run.
  const failed = new Set<string>()
  let from = start
  let index = start
  const take = (node: UserMarkdownInline, next: number) => {
    if (index > from) nodes.push({ type: "text", text: text.slice(from, index) })
    nodes.push(node)
    index = next
    from = next
  }
  while (index < end) {
    const mention = mentions.get(index)
    if (mention && mention.end <= end) {
      take({ type: "mention", text: text.slice(index, mention.end), mention: mention.type }, mention.end)
      continue
    }
    const char = text[index]!
    if (char === "`") {
      const run = runLength(text, index, end, char)
      const close = failed.has(char + run) ? -1 : codeClose(text, index + run, end, run)
      if (close > index + run) {
        take(
          { type: "code", text: text.slice(index + run, close), start: index, end: close + run, marker: run },
          close + run,
        )
        continue
      }
      failed.add(char + run)
      index += run
      continue
    }
    const url =
      text.startsWith("http", index) && !WORD.test(text[index - 1] ?? "") ? link(text.slice(index, end)) : undefined
    if (url) {
      take({ type: "link", text: url, start: index, end: index + url.length }, index + url.length)
      continue
    }
    const mark = char === "*" || char === "_" || char === "~" ? MARKS[char] : undefined
    if (!mark) {
      index++
      continue
    }
    const run = runLength(text, index, end, char)
    const opens =
      run <= 2 &&
      !open.includes(char) &&
      !WORD.test(text[index - 1] ?? "") &&
      index + run < end &&
      !SPACE.test(text[index + run]!)
    const close = opens && !failed.has(char + run) ? markClose(text, index + run, end, char, run, mentions) : -1
    if (close > 0) {
      const children = parseInline(text, index + run, close, mentions, open + char)
      take({ type: mark, children, start: index, end: close + run, marker: run }, close + run)
      continue
    }
    if (opens) failed.add(char + run)
    index += run
  }
  if (end > from) nodes.push({ type: "text", text: text.slice(from, end) })
  return nodes
}

function runLength(text: string, start: number, end: number, char: string) {
  let index = start
  while (index < end && text[index] === char) index++
  return index - start
}

function codeClose(text: string, start: number, end: number, run: number) {
  for (let index = start; index < end; index++) {
    if (text[index] !== "`") continue
    const length = runLength(text, index, end, "`")
    if (length === run) return index
    index += length - 1
  }
  return -1
}

function markClose(
  text: string,
  start: number,
  end: number,
  char: string,
  run: number,
  mentions: Map<number, UserMarkdownMention>,
) {
  for (let index = start; index < end; index++) {
    const mention = mentions.get(index)
    if (mention) {
      index = mention.end - 1
      continue
    }
    if (text[index] !== char) continue
    const length = runLength(text, index, end, char)
    if (length === run && index > start && !SPACE.test(text[index - 1]!) && !WORD.test(text[index + run] ?? "")) {
      return index
    }
    index += length - 1
  }
  return -1
}

function link(text: string) {
  const match = URL_PATTERN.exec(text)?.[0]
  if (!match) return
  const url = trimLink(match)
  return url.length > url.indexOf("//") + 2 ? url : undefined
}

function trimLink(url: string): string {
  if (/[.,;:!?]$/.test(url)) return trimLink(url.slice(0, -1))
  if (url.endsWith(")") && url.split("(").length < url.split(")").length) return trimLink(url.slice(0, -1))
  return url
}
