import { describe, expect, test } from "bun:test"
import { promptListMarker, promptListNewline, promptMarkdownRanges } from "../../src/prompt/markdown"

const styled = (text: string, mentions: { start: number; end: number }[] = []) =>
  promptMarkdownRanges(text, mentions).map((range) => `${range.style}@${range.depth}:${range.start}-${range.end}`)

describe("prompt markdown", () => {
  test("styles Slack marks with their markers in display offsets", () => {
    expect(styled("*hi* `x`")).toEqual([
      "bold@0:0-4",
      "marker@1:0-1",
      "marker@1:3-4",
      "code@0:5-8",
      "marker@1:5-6",
      "marker@1:7-8",
    ])
    // Wide characters count two cells before the bold range.
    expect(styled("中文 _ok_")).toEqual(["italic@0:5-9", "marker@1:5-6", "marker@1:8-9"])
  })

  test("styles list markers, quotes, and fenced code, but not marks inside code", () => {
    expect(styled("- *a*\n> q\n```\n*no*\n```")).toEqual([
      "list@0:0-2",
      "bold@0:2-5",
      "marker@1:2-3",
      "marker@1:4-5",
      "quote@0:6-9",
      "marker@1:6-8",
      "code-block@0:10-22",
      "marker@1:10-13",
      "marker@1:19-22",
    ])
  })

  test("leaves mentions to their own style", () => {
    expect(styled("*see @a_b_.ts now*", [{ start: 5, end: 13 }])).toEqual([
      "bold@0:0-5",
      "bold@0:13-18",
      "marker@1:0-1",
      "marker@1:17-18",
    ])
  })

  test.each([
    { name: "continues a bullet", text: "- one", offset: 5, edit: { start: 5, end: 5, text: "\n- " } },
    { name: "keeps the marker and indent", text: "  * one", offset: 7, edit: { start: 7, end: 7, text: "\n  * " } },
    { name: "numbers the next item", text: "9. nine", offset: 7, edit: { start: 7, end: 7, text: "\n10. " } },
    { name: "ends the list on an empty item", text: "- one\n- ", offset: 8, edit: { start: 6, end: 8, text: "" } },
    { name: "ignores the cursor before the content", text: "- one", offset: 1, edit: undefined },
    { name: "ignores plain lines", text: "one", offset: 3, edit: undefined },
    { name: "ignores lines in fenced code", text: "```\n- one\n```", offset: 9, edit: undefined },
  ])("newline $name", (row) => {
    expect(promptListNewline(row.text, row.offset)).toEqual(row.edit)
  })

  test("Backspace removes a list marker only at the start of the item content", () => {
    expect(promptListMarker("x\n  1. one", 7)).toEqual({ start: 2, end: 7 })
    expect(promptListMarker("x\n  1. one", 8)).toBeUndefined()
    expect(promptListMarker("x\none", 2)).toBeUndefined()
  })
})
