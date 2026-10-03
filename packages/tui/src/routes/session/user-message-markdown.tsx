import { For, createMemo } from "solid-js"
import {
  parseUserMarkdown,
  type UserMarkdownBlock,
  type UserMarkdownInline,
  type UserMarkdownMention,
} from "@opencode/util/user-markdown"
import { useTheme } from "../../context/theme"

/** A user message with Slack-style Markdown: marks, links, lists, quotes, and code. Mentions stay literal. */
export function UserMessageMarkdown(props: { text: string; mentions: readonly UserMarkdownMention[] }) {
  const blocks = createMemo(() => parseUserMarkdown(props.text, [...props.mentions]))
  return (
    <box flexDirection="column">
      <For each={blocks()}>{(block) => <Block block={block} />}</For>
    </box>
  )
}

// Parsed blocks and nodes are immutable, so each one renders its shape once.
function Block(props: { block: UserMarkdownBlock }) {
  const theme = useTheme()
  const block = props.block
  if (block.type === "code") {
    return (
      <box backgroundColor={theme.background.base} paddingLeft={1} paddingRight={1}>
        <text fg={theme.markdown.codeBlock}>{block.text}</text>
      </box>
    )
  }
  if (block.type === "quote") {
    return (
      <box border={["left"]} borderColor={theme.markdown.blockQuote} paddingLeft={1}>
        <text fg={theme.markdown.blockQuote}>
          <Inline nodes={block.children} />
        </text>
      </box>
    )
  }
  if (block.type === "list") {
    return (
      <box flexDirection="column">
        <For each={block.items}>
          {(item) => (
            <box flexDirection="row">
              <text flexShrink={0} fg={block.ordered ? theme.markdown.listEnumeration : theme.markdown.listItem}>
                {block.ordered ? `${item.value}. ` : "• "}
              </text>
              <text fg={theme.text.base}>
                <Inline nodes={item.children} />
              </text>
            </box>
          )}
        </For>
      </box>
    )
  }
  return (
    <text fg={theme.text.base}>
      <Inline nodes={block.children} />
    </text>
  )
}

function Inline(props: { nodes: UserMarkdownInline[] }) {
  const theme = useTheme()
  return (
    <For each={props.nodes}>
      {(node) => {
        if (node.type === "text" || node.type === "mention") return node.text
        if (node.type === "code") {
          return <span style={{ fg: theme.markdown.code, bg: theme.background.base }}>{node.text}</span>
        }
        if (node.type === "link") {
          return (
            <a href={node.text} style={{ fg: theme.markdown.link, underline: true }}>
              {node.text}
            </a>
          )
        }
        if (node.type === "bold") {
          return (
            <span style={{ fg: theme.markdown.strong, bold: true }}>
              <Inline nodes={node.children} />
            </span>
          )
        }
        if (node.type === "italic") {
          return (
            <span style={{ fg: theme.markdown.emphasis, italic: true }}>
              <Inline nodes={node.children} />
            </span>
          )
        }
        return (
          <span style={{ strikethrough: true }}>
            <Inline nodes={node.children} />
          </span>
        )
      }}
    </For>
  )
}
