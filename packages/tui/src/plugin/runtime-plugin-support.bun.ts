import { ensurePluginRuntime, pluginRuntimeModules } from "@opencode/plugin/runtime.bun"
import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

ensureRuntimePluginSupport({
  additional: {
    ...pluginRuntimeModules(),
    "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin },
  },
})
ensurePluginRuntime()
