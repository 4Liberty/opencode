import type { QuickPromptContext } from "../../shared/ipc-contract"

let recent: QuickPromptContext | null = null

export function getQuickPromptContext() {
  return recent
}

export function setQuickPromptContext(context: QuickPromptContext) {
  recent = context
}
