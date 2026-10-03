import { expect, test } from "bun:test"
import type { ComposerPrompt } from "../types"
import { getCursorPosition, readComposerEditor, renderComposerEditor, setCursorPosition } from "./dom"

const br = () => document.createElement("br")
const text = (value: string) => document.createTextNode(value)
const pill = () => {
  const element = document.createElement("span")
  element.dataset.mention = "file"
  element.textContent = "@file"
  return element
}
const element = (tag: string, ...children: Node[]) => {
  const node = document.createElement(tag)
  node.append(...children)
  return node
}
const promptText = (prompt: ComposerPrompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

// Breaks count as one character and zero-width characters count as none. List markers exist only in the prompt.
// Each caret row is [position, child index path from the container (empty for the container), anchor offset].
test.each<{ name: string; nodes: () => Node[]; text: string; caret: [number, number[], number][] }>([
  {
    name: "zero-width characters",
    nodes: () => [text("ab\u200B"), br(), text("cd")],
    text: "ab\ncd",
    caret: [
      [3, [2], 0],
      [4, [2], 1],
    ],
  },
  {
    name: "pills and breaks",
    nodes: () => [text("ab"), pill(), br(), text("cd")],
    text: "ab@file\ncd",
    caret: [
      [2, [0], 2],
      [7, [], 2],
      [8, [3], 0],
    ],
  },
  {
    name: "blank lines",
    nodes: () => [text("a"), br(), br(), text("b")],
    text: "a\n\nb",
    caret: [
      [2, [], 2],
      [3, [3], 0],
    ],
  },
  {
    name: "list items",
    nodes: () => [text("intro\n"), element("ul", element("li", text("a")), element("li", br())), text("after")],
    text: "intro\n- a\n- \nafter",
    caret: [
      [8, [1, 0, 0], 0],
      [9, [1, 0, 0], 1],
      [12, [1, 1], 0],
      [13, [2], 0],
    ],
  },
  {
    name: "numbered items and line blocks",
    nodes: () => {
      const list = element("ol", element("li", text("x")), element("li", text("y")))
      if (list instanceof HTMLOListElement) list.start = 3
      return [list, element("div", br()), element("div", text("z"))]
    },
    text: "3. x\n4. y\n\nz",
    caret: [
      [3, [0, 0, 0], 0],
      [10, [1], 0],
      [11, [2, 0], 0],
    ],
  },
])("maps the prompt and the caret across $name", (row) => {
  const container = document.createElement("div")
  container.append(...row.nodes())
  document.body.appendChild(container)

  expect(promptText(readComposerEditor(container, true).prompt)).toBe(row.text)
  row.caret.forEach(([position, path, offset]) => {
    setCursorPosition(container, position)
    const selection = window.getSelection()
    expect(selection?.anchorNode).toBe(path.reduce<Node>((node, index) => node.childNodes[index]!, container))
    expect(selection?.anchorOffset).toBe(offset)
    expect(getCursorPosition(container)).toBe(position)
  })

  container.remove()
})

test.each<{ text: string; lists: string[] }>([
  { text: "intro\n- a\n- b\nafter", lists: ["UL:a,b"] },
  { text: "intro\n\n- a\n\nafter", lists: ["UL:a"] },
  { text: "- a\n", lists: ["UL:a"] },
  { text: "- \n1. a\n2. b\n4. c", lists: ["UL:", "OL:a,b", "OL:c"] },
  { text: "-  spaced", lists: ["UL: spaced"] },
  { text: "```\n- code\n```", lists: [] },
  { text: "* star\n• dot\n  - indented\n1) paren", lists: [] },
])("renders $text with lists that read back unchanged", (row) => {
  const container = document.createElement("div")
  document.body.appendChild(container)
  renderComposerEditor(container, [{ type: "text", content: row.text, start: 0, end: row.text.length }], true)

  expect(
    Array.from(container.querySelectorAll("ul, ol")).map(
      (list) => `${list.tagName}:${Array.from(list.children, (item) => item.textContent).join(",")}`,
    ),
  ).toEqual(row.lists)
  const read = readComposerEditor(container, true)
  expect(promptText(read.prompt)).toBe(row.text)
  expect(read.stale).toBe(false)

  renderComposerEditor(container, [{ type: "text", content: row.text, start: 0, end: row.text.length }], false)
  expect(container.querySelectorAll("li")).toHaveLength(0)
  expect(promptText(readComposerEditor(container, false).prompt)).toBe(row.text)

  container.remove()
})

test("previews inline styles with their markers in the text", () => {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const value = "*hi* _it_ ~no~ `a*b*` https://x.dev\n- **bold** item\n> quote\n```\nx _y_\n```"
  renderComposerEditor(container, [{ type: "text", content: value, start: 0, end: value.length }], true)

  expect(
    Array.from(container.querySelectorAll("[data-md]:not([data-md=marker])"), (span) => {
      const markers = Array.from(span.children, (child) => (child instanceof HTMLElement ? child.dataset.md : ""))
      return `${span.getAttribute("data-md")}:${span.textContent}:${markers.filter((md) => md === "marker").length}`
    }),
  ).toEqual([
    "bold:*hi*:2",
    "italic:_it_:2",
    "strike:~no~:2",
    "code:`a*b*`:2",
    "link:https://x.dev:0",
    "bold:**bold**:2",
    "quote:> quote:1",
    "code-block:```\nx _y_\n```:2",
  ])
  const read = readComposerEditor(container, true)
  expect(promptText(read.prompt)).toBe(value)
  expect(read.stale).toBe(false)

  renderComposerEditor(container, [{ type: "text", content: value, start: 0, end: value.length }], false)
  expect(container.querySelectorAll("[data-md]")).toHaveLength(0)

  container.remove()
})

test("restyles typed markers and keeps the caret outside a closed style", () => {
  const container = document.createElement("div")
  document.body.appendChild(container)
  container.append(text("say *hi*"))
  setCursorPosition(container, 8)
  expect(readComposerEditor(container, true).stale).toBe(true)

  renderComposerEditor(container, [{ type: "text", content: "say *hi* now", start: 0, end: 12 }], true)
  setCursorPosition(container, 8)
  expect(window.getSelection()?.anchorNode?.textContent).toBe(" now")
  expect(window.getSelection()?.anchorOffset).toBe(0)
  setCursorPosition(container, 5)
  expect(window.getSelection()?.anchorNode?.textContent).toBe("hi")
  expect(window.getSelection()?.anchorOffset).toBe(0)
  setCursorPosition(container, 4)
  expect(window.getSelection()?.anchorNode?.textContent).toBe("say ")

  container.remove()
})

test("keeps mentions inside rendered list items", () => {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const prompt: ComposerPrompt = [
    { type: "text", content: "- see ", start: 0, end: 6 },
    { type: "file", path: "src/app.tsx", content: "@src/app.tsx", start: 6, end: 18 },
    { type: "text", content: "\n- done", start: 18, end: 25 },
  ]
  renderComposerEditor(container, prompt, true)

  const read: ComposerPrompt = readComposerEditor(container, true).prompt
  expect(container.querySelector("li [data-mention=file]")?.textContent).toBe("@src/app.tsx")
  expect(read).toEqual(prompt)

  container.remove()
})

test.each([
  { name: "a typed dash", typed: "intro\n- ", text: "intro\n- " },
  { name: "a typed number", typed: "1. ", text: "1. " },
  { name: "a typed asterisk", typed: "* ", text: "- " },
  { name: "a typed bullet", typed: "• ", text: "- " },
])("turns $name at the start of a line into a list item", (row) => {
  const container = document.createElement("div")
  document.body.appendChild(container)
  container.append(text(row.typed))
  setCursorPosition(container, row.typed.length)

  const read = readComposerEditor(container, true)
  expect(promptText(read.prompt)).toBe(row.text)
  expect(read.cursor).toBe(row.text.length)
  expect(read.stale).toBe(true)
  expect(readComposerEditor(container, false).stale).toBe(false)

  container.remove()
})

test("moves extra lines out of a list item", () => {
  const container = document.createElement("div")
  document.body.appendChild(container)
  container.append(element("ul", element("li", text("a\nb"))))

  const read = readComposerEditor(container, true)
  expect(promptText(read.prompt)).toBe("- a\nb")
  expect(read.stale).toBe(true)

  container.remove()
})
