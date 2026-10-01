import { createMemoryHistory, MemoryRouter, type BaseRouterProps } from "@solidjs/router"
import { onCleanup } from "solid-js"
import { getLastActiveUrl, setLastActiveUrl } from "./route-storage"

export function DesktopMemoryRouter(props: BaseRouterProps & { windowID: string; initialUrl?: string }) {
  const history = createMemoryHistory()
  const initialUrl = props.initialUrl ?? getLastActiveUrl(props.windowID)
  if (initialUrl !== "/") history.set({ value: initialUrl, replace: true, scroll: false })
  if (!props.initialUrl) onCleanup(history.listen((value) => setLastActiveUrl(props.windowID, value)))
  return <MemoryRouter {...props} history={history} />
}
