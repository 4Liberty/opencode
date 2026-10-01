const windowIDPrefix = "--opencode-window-id="
const windowKindPrefix = "--opencode-window-kind="

export type WindowKind = "main" | "quick-prompt"

export function windowIDArgument(id: string) {
  return windowIDPrefix + encodeURIComponent(id)
}

export function windowKindArgument(kind: WindowKind) {
  return windowKindPrefix + kind
}

export function windowIDFromArguments(args: readonly string[]) {
  const value = args.find((arg) => arg.startsWith(windowIDPrefix))?.slice(windowIDPrefix.length)
  if (!value) throw new Error("Window ID argument not found")
  return decodeURIComponent(value)
}

export function windowKindFromArguments(args: readonly string[]) {
  const value = args.find((arg) => arg.startsWith(windowKindPrefix))?.slice(windowKindPrefix.length)
  if (value === "main" || value === "quick-prompt") return value
  throw new Error("Window kind argument not found or invalid")
}
