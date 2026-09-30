import path from "node:path"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Schedule } from "effect"
import { ConfigMCP } from "@opencode/schema/config/mcp"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Instance } from "@opencode/core/instance/service"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Mcp } from "@opencode/core/mcp/index"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEnvironment } from "@opencode/core/session/environment"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { Tool } from "@opencode/core/tool"
import { McpTool } from "@opencode/core/tool/mcp"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { codeModeListings, waitForCodeModeTool } from "./lib/tool"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"

const transport = Layer.succeed(
  SessionModelTransport.Service,
  SessionModelTransport.Service.of({
    bind: () => ({ execute: () => Effect.die("Unexpected WebSocket execution") }),
    close: () => Effect.void,
    closeAll: Effect.void,
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionEnvironment.node,
      Session.node,
      Instance.node,
      LocationServiceMap.node,
    ]),
    [
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      SessionModelTransport.node.replace(transport),
      offlineModels,
    ],
  ),
)

const fixture = Effect.gen(function* () {
  const temporary = yield* tmpdirScoped()
  const location = Location.Ref.make({ directory: AbsolutePath.make(temporary.path) })
  const locations = yield* LocationServiceMap.Service
  const context = yield* Effect.acquireRelease(locations.contextEffect(location), () => locations.invalidate(location))
  const server = (identity: string) =>
    new ConfigMCP.Local({
      type: "local",
      command: [
        process.execPath,
        path.join(import.meta.dir, "fixture/mcp-identity.ts"),
        identity,
        path.join(temporary.path, `${identity}.pid`),
      ],
    })
  const pid = (identity: string) =>
    Effect.promise(() => Bun.file(path.join(temporary.path, `${identity}.pid`)).text()).pipe(Effect.map(Number))
  return {
    location,
    server,
    pid,
    mcp: Context.get(context, Mcp.Service),
    mcpTools: Context.get(context, McpTool.Service),
    registry: Context.get(context, Tool.Service),
  }
})

const whoami = (mcp: Mcp.Interface, sessionID?: Session.ID) =>
  mcp
    .callTool({ server: "ctx", name: "whoami", sessionID })
    .pipe(Effect.map((result) => result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")))

// The harness still reads the user's global config, so assertions only look at the fixture's server.
const toolNames = (tools: ReadonlyArray<Mcp.Tool>) =>
  tools.filter((tool) => tool.server === "ctx").map((tool) => `${tool.server}.${tool.name}`)
const serverNames = (servers: ReadonlyArray<Mcp.ServerInfo>) =>
  servers.map((server) => server.name).filter((name) => name === "ctx")

const running = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const exited = (pid: number) =>
  Effect.suspend(() => (running(pid) ? Effect.fail(`process ${pid} is still running`) : Effect.void)).pipe(
    Effect.retry({ times: 300, schedule: Schedule.spaced("10 millis") }),
  )

describe("Session-scoped MCP servers", () => {
  it.live("are visible only to their Session tree and shadow Location servers there", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ location: test.location })
      const child = yield* sessions.create({ parentID: root.id })
      const other = yield* sessions.create({ location: test.location })
      const bystander = yield* sessions.create({ location: test.location })

      yield* test.mcp.add("ctx", test.server("root"), root.id)

      expect(toolNames(yield* test.mcp.tools(root.id))).toEqual(["ctx.only_root", "ctx.whoami"])
      expect(toolNames(yield* test.mcp.tools(child.id))).toEqual(["ctx.only_root", "ctx.whoami"])
      expect(toolNames(yield* test.mcp.tools(other.id))).toEqual([])
      expect(toolNames(yield* test.mcp.tools())).toEqual([])
      expect(serverNames(yield* test.mcp.servers())).toEqual([])
      expect(serverNames(yield* test.mcp.servers(child.id))).toEqual(["ctx"])
      expect(yield* whoami(test.mcp, child.id)).toBe("root")
      expect(yield* whoami(test.mcp, other.id).pipe(Effect.flip)).toBeInstanceOf(Mcp.NotFoundError)

      yield* test.mcp.add("ctx", test.server("other"), other.id)
      yield* test.mcp.add("ctx", test.server("location"))

      expect(yield* whoami(test.mcp, root.id)).toBe("root")
      expect(yield* whoami(test.mcp, other.id)).toBe("other")
      expect(yield* whoami(test.mcp, bystander.id)).toBe("location")
      expect(yield* whoami(test.mcp)).toBe("location")
      expect(toolNames(yield* test.mcp.tools(root.id))).toEqual(["ctx.only_root", "ctx.whoami"])
      expect(toolNames(yield* test.mcp.tools())).toEqual(["ctx.only_location", "ctx.whoami"])

      yield* waitForCodeModeTool(test.registry, "ctx.only_location")
      const listed = (sessionID: Session.ID) =>
        test.mcpTools.overlay(sessionID).pipe(
          Effect.flatMap((overlay) => test.registry.snapshot(undefined, overlay)),
          Effect.map((snapshot) =>
            (snapshot.codeModeCatalog ? codeModeListings(snapshot.codeModeCatalog) : [])
              .map((tool) => tool.path)
              .filter((path) => path.startsWith("ctx.")),
          ),
        )
      expect(yield* listed(child.id)).toEqual(["ctx.only_root", "ctx.whoami"])
      expect(yield* listed(bystander.id)).toEqual(["ctx.only_location", "ctx.whoami"])
    }),
  )

  it.live("releases servers on replacement, removal, and Session deletion", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const sessions = yield* Session.Service
      const first = yield* sessions.create({ location: test.location })
      const second = yield* sessions.create({ location: test.location })

      yield* test.mcp.add("ctx", test.server("first"), first.id)
      yield* test.mcp.add("ctx", test.server("second"), second.id)
      const firstPid = yield* test.pid("first")
      const secondPid = yield* test.pid("second")

      yield* test.mcp.add("ctx", test.server("first"), first.id)
      expect(yield* test.pid("first")).toBe(firstPid)
      expect(running(firstPid)).toBe(true)

      yield* test.mcp.add("ctx", test.server("replaced"), first.id)
      yield* exited(firstPid)
      expect(yield* whoami(test.mcp, first.id)).toBe("replaced")
      expect(yield* whoami(test.mcp, second.id)).toBe("second")
      expect(running(secondPid)).toBe(true)

      const replacedPid = yield* test.pid("replaced")
      yield* test.mcp.remove("ctx", first.id)
      yield* exited(replacedPid)
      expect(toolNames(yield* test.mcp.tools(first.id))).toEqual([])
      expect(yield* test.mcp.remove("ctx", first.id).pipe(Effect.flip)).toBeInstanceOf(Mcp.NotFoundError)

      yield* sessions.remove(second.id)
      yield* exited(secondPid)
      expect(toolNames(yield* test.mcp.tools(second.id))).toEqual([])
    }),
  )
})
