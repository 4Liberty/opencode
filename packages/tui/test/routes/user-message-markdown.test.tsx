/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import { UserMessageMarkdown } from "../../src/routes/session/user-message-markdown"
import { emptyThemeSource } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("renders Slack-style Markdown in a user message without its markers", async () => {
  const text = [
    "Please *review* @src/_a_.ts before _shipping_:",
    "- Check the ~old~ `parse` path",
    "2. Run tests",
    "> Quoted note",
    "```",
    "const value = *raw*",
    "```",
  ].join("\n")
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "opencode", mode: "dark" } })}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <UserMessageMarkdown text={text} mentions={[{ start: 16, end: 27, type: "file" }]} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 60, height: 8 },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Please"))
    const lines = app
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
    expect(lines.slice(0, 6)).toEqual([
      "Please review @src/_a_.ts before shipping:",
      "• Check the old parse path",
      "2. Run tests",
      "│ Quoted note",
      " const value = *raw*",
      "",
    ])
    const spans = app.captureSpans().lines
    const span = (line: number, text: string) => spans[line]?.spans.find((item) => item.text === text)
    expect(span(0, "review")?.attributes ?? 0).toBe(TextAttributes.BOLD)
    expect(span(0, "shipping")?.attributes ?? 0).toBe(TextAttributes.ITALIC)
    expect(span(1, "old")?.attributes ?? 0).toBe(TextAttributes.STRIKETHROUGH)
  } finally {
    app.renderer.destroy()
  }
})
