import { describe, expect, test } from "bun:test"
import { quickPromptAccelerator } from "./quick-prompt-keybind"

describe("quick prompt accelerator", () => {
  test("converts app keybinds to Electron accelerators", () => {
    expect(quickPromptAccelerator("mod+shift+space")).toBe("CommandOrControl+Shift+Space")
    expect(quickPromptAccelerator("ctrl+alt+k")).toBe("Control+Alt+K")
    expect(quickPromptAccelerator("mod+comma")).toBe("CommandOrControl+,")
  })

  test("rejects unsafe and unsupported keybinds", () => {
    expect(quickPromptAccelerator("k")).toBeUndefined()
    expect(quickPromptAccelerator("shift+k")).toBeUndefined()
    expect(quickPromptAccelerator("mod+shift+k,mod+k")).toBeUndefined()
    expect(quickPromptAccelerator("mod+unknown-key")).toBeUndefined()
  })
})
