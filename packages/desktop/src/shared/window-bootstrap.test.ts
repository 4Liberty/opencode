import { describe, expect, test } from "bun:test"
import {
  windowIDArgument,
  windowIDFromArguments,
  windowKindArgument,
  windowKindFromArguments,
} from "./window-bootstrap"

describe("window bootstrap", () => {
  test("round-trips the window ID through renderer arguments", () => {
    const id = "window/id with spaces"
    expect(windowIDFromArguments(["electron", windowIDArgument(id)])).toBe(id)
  })

  test("requires a window ID argument", () => {
    expect(() => windowIDFromArguments(["electron"])).toThrow("Window ID argument not found")
  })

  test("round-trips the window kind", () => {
    expect(windowKindFromArguments([windowKindArgument("quick-prompt")])).toBe("quick-prompt")
  })

  test("rejects a missing or invalid window kind", () => {
    expect(() => windowKindFromArguments([])).toThrow("Window kind argument not found or invalid")
    expect(() => windowKindFromArguments(["--opencode-window-kind=other"])).toThrow(
      "Window kind argument not found or invalid",
    )
  })
})
