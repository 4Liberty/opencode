import type { WindowKind } from "../shared/window-bootstrap"

export type ElectronNative = {
  windowID: string
  windowKind: WindowKind
  getPathForFile(file: File): string
}
