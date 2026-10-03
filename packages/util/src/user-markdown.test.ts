import { expect, test } from "bun:test"
import {
  parseUserMarkdown,
  type UserMarkdownBlock,
  type UserMarkdownInline,
  type UserMarkdownMention,
} from "./user-markdown.js"

const inline = (nodes: UserMarkdownInline[]): string =>
  nodes
    .map((node) => {
      if (node.type === "text") return node.text
      if (node.type === "mention") return `[${node.mention}:${node.text}]`
      if (node.type === "code") return `<code>${node.text}</code>`
      if (node.type === "link") return `<a>${node.text}</a>`
      const tag = { bold: "b", italic: "i", strike: "s" }[node.type]
      return `<${tag}>${inline(node.children)}</${tag}>`
    })
    .join("")
const blocks = (value: UserMarkdownBlock[]) =>
  value.map((block) => {
    if (block.type === "code") return `<pre>${block.text}</pre>`
    if (block.type === "quote") return `<quote>${inline(block.children)}</quote>`
    if (block.type === "paragraph") return `<p>${inline(block.children)}</p>`
    const tag = block.ordered ? "ol" : "ul"
    return `<${tag}>${block.items.map((item) => `<li${block.ordered ? ` ${item.value}` : ""}>${inline(item.children)}</li>`).join("")}</${tag}>`
  })

test.each<{ name: string; text: string; mentions?: UserMarkdownMention[]; html: string[] }>([
  { name: "plain text", text: "Line one\n\nLine two", html: ["<p>Line one\n\nLine two</p>"] },
  {
    name: "lists",
    text: "Plan:\n- one\n* two\n• three\n  - nested\n1. first\n3. third",
    html: [
      "<p>Plan:</p>",
      "<ul><li>one</li><li>two</li><li>three</li><li>nested</li></ul>",
      "<ol><li 1>first</li><li 3>third</li></ol>",
    ],
  },
  {
    name: "a blank line before a block",
    text: "intro\n\n- a\n\nafter",
    html: ["<p>intro\n\n</p>", "<ul><li>a</li></ul>", "<p>\nafter</p>"],
  },
  {
    name: "Slack marks and Markdown doubles",
    text: "*bold* _italic_ ~strike~ `code` **double** ~~gone~~ *_both_*",
    html: [
      "<p><b>bold</b> <i>italic</i> <s>strike</s> <code>code</code> <b>double</b> <s>gone</s> <b><i>both</i></b></p>",
    ],
  },
  {
    name: "markers inside words or beside spaces",
    text: "snake_case_name 2*3*4 a * b * c ~/dir *open\nclose* *trailing *",
    html: ["<p>snake_case_name 2*3*4 a * b * c ~/dir *open\nclose* *trailing *</p>"],
  },
  {
    name: "code spans that hide marks",
    text: "`*not bold*` ``a ` b``",
    html: ["<p><code>*not bold*</code> <code>a ` b</code></p>"],
  },
  {
    name: "fenced code",
    text: "```ts\nconst a = *b*\n- item\n```\n```\nunclosed *bold*",
    html: ["<pre>const a = *b*\n- item</pre>", "<p>```\nunclosed <b>bold</b></p>"],
  },
  {
    name: "quotes",
    text: "> quoted *bold*\n>second\nafter",
    html: ["<quote>quoted <b>bold</b>\nsecond</quote>", "<p>after</p>"],
  },
  {
    name: "mentions as atoms",
    text: "*see @src/_a_.ts* @build",
    mentions: [
      { start: 5, end: 16, type: "file" },
      { start: 18, end: 24, type: "agent" },
    ],
    html: ["<p><b>see [file:@src/_a_.ts]</b> [agent:@build]</p>"],
  },
  {
    name: "links",
    text: "Visit https://example.com/a_b_(c)), or (https://x.dev). Not xhttps://no.",
    html: ["<p>Visit <a>https://example.com/a_b_(c)</a>), or (<a>https://x.dev</a>). Not xhttps://no.</p>"],
  },
])("parses $name", (row) => {
  expect(blocks(parseUserMarkdown(row.text, row.mentions))).toEqual(row.html)
})
