import { contextBridge, ipcRenderer, webUtils } from "electron"
import { IpcTransportPort } from "../shared/ipc-transport"
import { windowIDFromArguments, windowKindFromArguments } from "../shared/window-bootstrap"

ipcRenderer.on(IpcTransportPort, (event) => {
  const port = event.ports[0]
  if (port) window.postMessage(IpcTransportPort, "*", [port])
})

contextBridge.exposeInMainWorld("electron", {
  windowID: windowIDFromArguments(process.argv),
  windowKind: windowKindFromArguments(process.argv),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
})
