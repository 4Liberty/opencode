/// <reference path="./env.d.ts" />

// Load the complete preload contract before App's optional browser bridge declaration.
import {
  AppBaseProviders,
  AppInterface,
  currentRoute,
  PlatformProvider,
  preloadRoute,
  ServerConnection,
  useCommand,
  useCurrentRoute,
  useLanguage,
  useLayout,
  useTabs,
  useWslServers,
  type LayoutRoute,
  type UpdaterPlatform,
} from "@opencode-ai/app/desktop"
import { useTheme } from "@opencode-ai/ui/theme/context"
import type { BaseRouterProps } from "@solidjs/router"
import { createEffect, createMemo, createResource, lazy, onCleanup, onMount, Show, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import type { ElectronAPI } from "./api-types"
import { DesktopFirstLaunchOnboarding } from "./onboarding"
import { createDesktopPlatform, type DesktopWindowState } from "./platform"
import { bindDesktopMenu } from "./platform/menu"
import { createSidecarResolver, initializationData, sidecarHttp } from "./startup/initialization"
import { preloadStoredLocale } from "./startup/locale"
import { LoadingSplash } from "./startup/splash"
import { getLastActiveUrl } from "./window/route-storage"
import { DesktopMemoryRouter } from "./window/router"
import { availableStartupServer, readyWslConnections } from "./wsl/connections"

const MigrationStatus = lazy(() => import("./migration-status").then((module) => ({ default: module.MigrationStatus })))

export function DesktopApp(props: { api: ElectronAPI; updater: UpdaterPlatform; version: string }) {
  const windowState = { id: props.api.getWindowID(), version: props.version }
  const quickPrompt = props.api.getWindowKind() === "quick-prompt"
  const initialUrl = quickPrompt ? "/quick-prompt" : getLastActiveUrl(windowState.id)
  const url = new URL(initialUrl, "http://localhost")
  const route = quickPrompt ? ({ type: "home" } as const) : currentRoute(url.pathname, url.search)
  const [startup, setStartup] = createStore<{ ready: boolean; visible: boolean; route: LayoutRoute }>({
    ready: false,
    visible: true,
    route,
  })
  return (
    <>
      <DesktopWindow
        api={props.api}
        updater={props.updater}
        windowState={windowState}
        quickPrompt={quickPrompt}
        onReady={() => setStartup("ready", true)}
        onRoute={(route) => setStartup("route", route)}
      />
      <Show when={startup.visible}>
        <div
          class="fixed inset-0 z-[100] transition-opacity duration-300 ease-out"
          classList={{ "pointer-events-none opacity-0": startup.ready }}
          onTransitionEnd={(event) => {
            if (event.target !== event.currentTarget || !startup.ready) return
            setStartup("visible", false)
          }}
        >
          <LoadingSplash deep={startup.route.type === "draft"} />
        </div>
      </Show>
    </>
  )
}

function DesktopWindow(props: {
  api: ElectronAPI
  updater: UpdaterPlatform
  windowState: DesktopWindowState
  quickPrompt: boolean
  onReady: () => void
  onRoute: (route: LayoutRoute) => void
}) {
  const platform = createDesktopPlatform(props.api, props.windowState, props.updater)
  const [sidecar, { mutate: setSidecar }] = createResource(() => props.api.awaitInitialization())
  const [defaultServer] = createResource(() => platform.getDefaultServer?.())
  const [locale] = createResource(() => preloadStoredLocale(platform))
  const [initialRoute] = createResource(() =>
    preloadRoute(props.quickPrompt ? "/quick-prompt" : getLastActiveUrl(props.windowState.id)),
  )
  const router = (routerProps: BaseRouterProps) => (
    <DesktopMemoryRouter
      {...routerProps}
      windowID={props.windowState.id}
      initialUrl={props.quickPrompt ? "/quick-prompt" : undefined}
    />
  )

  function ReadyApp() {
    const wslServers = useWslServers()
    const language = useLanguage()
    const ready = createMemo(
      () => !defaultServer.loading && !sidecar.loading && !locale.loading && !wslServers.isLoading,
    )
    const servers = createMemo(() => {
      const data = initializationData(sidecar)
      const list: ServerConnection.Any[] = []
      if (data) {
        list.push({
          displayName: language.t("desktop.server.local"),
          type: "sidecar",
          variant: "base",
          http: sidecarHttp(data),
          reconnect: createSidecarResolver({ api: props.api, current: sidecar, update: setSidecar }),
        })
      }
      list.push(...readyWslConnections(wslServers.data, language.t("wsl.server.label")))
      return list
    })
    const effectiveDefaultServer = createMemo(() =>
      ServerConnection.Key.make(availableStartupServer(defaultServer.latest, wslServers.data)),
    )

    return (
      <Show when={ready()}>
        <Show when={effectiveDefaultServer()} keyed>
          {(key) => (
            <AppInterface defaultServer={key} servers={servers()} router={router}>
              <Show
                when={props.quickPrompt}
                fallback={
                  <DesktopStartupReady
                    api={props.api}
                    routeReady={() => !initialRoute.loading}
                    onReady={props.onReady}
                    onRoute={props.onRoute}
                  />
                }
              >
                <QuickPromptStartupReady routeReady={() => !initialRoute.loading} onReady={props.onReady} />
              </Show>
              <Show when={!props.quickPrompt}>
                <DesktopFirstLaunchOnboarding
                  api={props.api}
                  initialUrl={getLastActiveUrl(props.windowState.id)}
                  serverKey={key}
                />
              </Show>
              <DesktopEffects api={props.api} />
              <Suspense fallback={null}>
                <Show when={!props.quickPrompt}>
                  <Show when={initializationData(sidecar)} keyed>
                    {(server) => <MigrationStatus server={server} />}
                  </Show>
                </Show>
              </Suspense>
            </AppInterface>
          )}
        </Show>
      </Show>
    )
  }

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders
        locale={locale.latest}
        onNativeTranslations={(bundle) => void props.api.setNativeTranslations(bundle).catch(() => undefined)}
        onThemeApplied={(mode, scheme) => {
          void props.api.setTitlebar({ mode, scheme })
          void props.api.themeReady()
        }}
      >
        <Show when={true}>{(_) => <ReadyApp />}</Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}

function QuickPromptStartupReady(props: { routeReady: () => boolean; onReady: () => void }) {
  const tabs = useTabs()
  createEffect(() => {
    if (!props.routeReady() || !tabs.ready() || !tabs.infoReady()) return
    props.onReady()
  })
  return null
}

function DesktopStartupReady(props: {
  api: ElectronAPI
  routeReady: () => boolean
  onReady: () => void
  onRoute: (route: LayoutRoute) => void
}) {
  const tabs = useTabs()
  const layout = useLayout()
  const route = useCurrentRoute()
  createEffect(() => props.onRoute(route()))
  const reportQuickPromptContext = () => {
    const current = route()
    if (current.type === "session") {
      void props.api.setQuickPromptContext({ server: current.server, sessionID: current.sessionId })
      return
    }
    if (current.type === "draft") {
      const draft = tabs.store.find((tab) => tab.type === "draft" && tab.draftID === current.draftID)
      if (draft?.type === "draft")
        void props.api.setQuickPromptContext({ server: draft.server, directory: draft.directory })
      return
    }
    const selection = layout.home.selection()
    void props.api.setQuickPromptContext({ server: selection.server, directory: selection.directory })
  }
  createEffect(reportQuickPromptContext)
  onMount(() => {
    window.addEventListener("focus", reportQuickPromptContext)
    onCleanup(() => window.removeEventListener("focus", reportQuickPromptContext))
  })
  createEffect(() => {
    if (!props.routeReady() || !tabs.ready() || !tabs.infoReady()) return
    props.onReady()
  })
  return null
}

function DesktopEffects(props: { api: ElectronAPI }) {
  const command = useCommand()
  bindDesktopMenu((id) => command.trigger(id))
  const theme = useTheme()

  createEffect(() => {
    theme.themeId()
    theme.mode()
    const background = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
    if (background) void props.api.setBackgroundColor(background)
  })

  return null
}
