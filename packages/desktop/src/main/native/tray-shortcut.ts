export const TRAY_SHORTCUT = "CommandOrControl+Alt+O"

export function registerTrayShortcut(
  registry: { register: (key: string, callback: () => void) => boolean; unregister: (key: string) => void },
  open: () => void,
) {
  const state = { registered: registry.register(TRAY_SHORTCUT, open) }
  return {
    get registered() {
      return state.registered
    },
    dispose() {
      if (!state.registered) return
      registry.unregister(TRAY_SHORTCUT)
      state.registered = false
    },
  }
}
