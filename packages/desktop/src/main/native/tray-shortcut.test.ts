import { expect, test } from "bun:test"
import { registerTrayShortcut, TRAY_SHORTCUT } from "./tray-shortcut"

test("registers Command/Control+Alt+O and invokes the tray opener", () => {
  const callbacks = new Map<string, () => void>()
  const opened: string[] = []
  const released: string[] = []
  const shortcut = registerTrayShortcut(
    {
      register(key, callback) {
        callbacks.set(key, callback)
        return true
      },
      unregister(key) {
        released.push(key)
        callbacks.delete(key)
      },
    },
    () => {
      opened.push("tray")
    },
  )
  expect(TRAY_SHORTCUT).toBe("CommandOrControl+Alt+O")
  expect(shortcut.registered).toBe(true)
  callbacks.get(TRAY_SHORTCUT)?.()
  expect(opened).toEqual(["tray"])
  shortcut.dispose()
  shortcut.dispose()
  expect(released).toEqual([TRAY_SHORTCUT])
  expect(shortcut.registered).toBe(false)
  expect(callbacks.size).toBe(0)
})

test("does not unregister a shortcut it could not acquire", () => {
  const released: string[] = []
  const shortcut = registerTrayShortcut(
    {
      register: () => false,
      unregister: (key) => {
        released.push(key)
      },
    },
    () => {},
  )
  expect(shortcut.registered).toBe(false)
  shortcut.dispose()
  expect(released).toEqual([])
})
