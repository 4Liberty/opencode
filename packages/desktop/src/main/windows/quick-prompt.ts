import { app, BrowserWindow, screen } from "electron"
import { Effect, Path } from "effect"
import { windowIDArgument, windowKindArgument } from "../../shared/window-bootstrap"
import { DesktopPaths } from "../paths"
import { getBackgroundColor, windowAppearance } from "./appearance"
import { loadWindow } from "./protocol"
import { wireNavigationPolicy, wireRendererHeaders } from "./security"
import { openExternalURL } from "../files"
import { installQuickPromptShortcut } from "./quick-prompt-shortcut"

const width = 760
const height = 164

export const makeQuickPromptWindow = Effect.fn("Window.makeQuickPrompt")(function* () {
  const path = yield* Path.Path
  const paths = yield* DesktopPaths.resolve
  const runFork = Effect.runForkWith(yield* Effect.context())
  const appearance = windowAppearance(path, paths)
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    autoHideMenuBar: true,
    backgroundColor: getBackgroundColor() ?? appearance.backgroundColor,
    webPreferences: {
      ...appearance.webPreferences,
      additionalArguments: [windowIDArgument("quick-prompt"), windowKindArgument("quick-prompt")],
    },
  })
  let ready = false
  let requested = false
  let disposing = false

  const position = () => {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    win.setPosition(
      Math.round(display.workArea.x + (display.workArea.width - width) / 2),
      Math.round(display.workArea.y + Math.min(160, (display.workArea.height - height) / 3)),
      false,
    )
  }
  const show = () => {
    if (!ready) {
      requested = true
      return
    }
    if (win.isVisible() && win.isFocused()) {
      win.hide()
      return
    }
    position()
    win.show()
    win.focus()
  }

  wireNavigationPolicy(win, (url) => runFork(openExternalURL(url)))
  wireRendererHeaders(win)
  if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.once("ready-to-show", () => {
    ready = true
    if (requested) show()
  })
  win.on("blur", () => win.hide())
  const beforeQuit = () => {
    disposing = true
  }
  app.on("before-quit", beforeQuit)
  win.on("close", (event) => {
    if (disposing) return
    event.preventDefault()
    win.hide()
  })
  loadWindow(win, "index.html")
  const uninstall = installQuickPromptShortcut(show)

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      disposing = true
      app.off("before-quit", beforeQuit)
      uninstall()
      if (!win.isDestroyed()) win.destroy()
    }),
  )
})
