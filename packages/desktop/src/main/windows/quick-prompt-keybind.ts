export function quickPromptAccelerator(keybind: string) {
  if (keybind.includes(",")) return
  const parts = keybind.split("+").filter(Boolean)
  const key = parts.at(-1)
  if (!key || parts.length < 2) return
  const modifiers = parts.slice(0, -1).map((part) => modifier(part))
  if (modifiers.some((part) => !part)) return
  if (!parts.slice(0, -1).some((part) => part !== "shift")) return
  const acceleratorKey = namedKey(key)
  if (!acceleratorKey) return
  return [...modifiers, acceleratorKey].join("+")
}

function modifier(value: string) {
  if (value === "mod") return "CommandOrControl"
  if (value === "ctrl") return "Control"
  if (value === "meta") return "Command"
  if (value === "alt") return "Alt"
  if (value === "shift") return "Shift"
}

function namedKey(value: string) {
  const keys: Record<string, string> = {
    space: "Space",
    enter: "Enter",
    tab: "Tab",
    escape: "Escape",
    backspace: "Backspace",
    delete: "Delete",
    comma: ",",
    plus: "Plus",
    arrowup: "Up",
    arrowdown: "Down",
    arrowleft: "Left",
    arrowright: "Right",
    pageup: "PageUp",
    pagedown: "PageDown",
    home: "Home",
    end: "End",
  }
  if (keys[value]) return keys[value]
  if (/^[a-z0-9]$/i.test(value)) return value.toUpperCase()
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(value)) return value.toUpperCase()
}
