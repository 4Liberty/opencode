import { globalShortcut } from "electron"
import { QUICK_PROMPT_SHORTCUT_KEY } from "../storage/keys"
import { getStore } from "../storage/store"
import { quickPromptAccelerator } from "./quick-prompt-keybind"

export const DEFAULT_QUICK_PROMPT_SHORTCUT = "mod+shift+space"

let activeKeybind: string | undefined
let activeAccelerator: string | undefined
let trigger = () => {}
let installed = false

export function getQuickPromptShortcut() {
  if (installed) return activeKeybind ?? "none"
  const value = getStore().get(QUICK_PROMPT_SHORTCUT_KEY)
  return typeof value === "string" ? value : DEFAULT_QUICK_PROMPT_SHORTCUT
}

export function installQuickPromptShortcut(next: () => void) {
  trigger = next
  const keybind = getQuickPromptShortcut()
  installed = true
  setQuickPromptShortcut(keybind, false)
  return () => {
    if (activeAccelerator) globalShortcut.unregister(activeAccelerator)
    activeKeybind = undefined
    activeAccelerator = undefined
    trigger = () => {}
    installed = false
  }
}

export function setQuickPromptShortcut(keybind: string, persist = true) {
  const accelerator = keybind === "none" ? undefined : quickPromptAccelerator(keybind)
  if (keybind !== "none" && !accelerator) return false
  if (keybind === activeKeybind) return true

  const previousKeybind = activeKeybind
  const previousAccelerator = activeAccelerator
  if (previousAccelerator) globalShortcut.unregister(previousAccelerator)

  if (accelerator && !globalShortcut.register(accelerator, () => trigger())) {
    if (previousAccelerator) globalShortcut.register(previousAccelerator, () => trigger())
    return false
  }

  activeKeybind = keybind
  activeAccelerator = accelerator
  if (persist) getStore().set(QUICK_PROMPT_SHORTCUT_KEY, keybind)
  return true
}
