import { Effect } from "effect"
import {
  AIError,
  LLMRequest,
  Message,
  ToolDefinition,
  type LLMEvent,
  type ToolEntry,
  type ToolNamespace,
} from "./schema/index.js"
import { ProviderShared } from "./protocols/shared.js"

/**
 * How a protocol represents tool namespaces on the wire.
 *
 * Callers always name a namespaced tool by its declared path, for example
 * `{ namespace: "crm.orders", name: "list" }`. Flat protocols see
 * `crm_orders_list`; native protocols keep the outer namespace and see
 * `{ namespace: "crm", name: "orders_list" }`.
 */
export type NamespaceStyle = "flat" | "native"

interface ToolName {
  readonly namespace?: string
  readonly name: string
}

interface Leaf {
  readonly namespace?: string
  readonly tool: ToolDefinition
}

/**
 * Lower declared tool names in a request to the protocol's wire names, and
 * return the inverse for the protocol's tool events.
 */
export const lower = Effect.fn("ToolNames.lower")(function* (request: LLMRequest, style: NamespaceStyle) {
  const leaves = yield* collect(request.tools, [])
  const names = leaves.map((leaf) => {
    const declared = { namespace: leaf.namespace, name: leaf.tool.name }
    return { declared, wire: key(wire(declared, style)) }
  })
  const collision = names.flatMap((entry, index) =>
    names
      .slice(0, index)
      .filter((other) => other.wire === entry.wire)
      .map((other) => [other, entry] as const),
  )[0]
  if (collision !== undefined)
    return yield* ProviderShared.invalidRequest(
      `Tools "${key(collision[0].declared)}" and "${key(collision[1].declared)}" both use the provider tool name "${collision[1].wire}"`,
    )
  const declared = new Map(names.map((entry) => [entry.wire, entry.declared]))
  return {
    request: LLMRequest.update(request, {
      tools: style === "flat" ? leaves.map((leaf) => rename(leaf, style)) : yield* nativeTools(request.tools),
      messages: lowerMessages(request.messages, style),
    }),
    raise: (event: LLMEvent): LLMEvent => {
      if (!("name" in event)) return event
      const name = declared.get(key(event))
      return name === undefined ? event : { ...event, namespace: name.namespace, name: name.name }
    },
  }
})

const collect = (tools: ReadonlyArray<ToolEntry>, path: ReadonlyArray<string>): Effect.Effect<Leaf[], AIError> =>
  Effect.forEach(tools, (tool) => {
    if (tool.type === "tool")
      return Effect.succeed([{ namespace: path.length === 0 ? undefined : path.join("."), tool }])
    if (tool.name.includes("."))
      return ProviderShared.invalidRequest(`Tool namespace "${tool.name}" must not contain "."`)
    return collect(tool.tools, [...path, tool.name])
  }).pipe(Effect.map((groups) => groups.flat()))

// Native namespaces are one level deep, so deeper levels join into the leaf name.
const nativeTools = (tools: ReadonlyArray<ToolEntry>) =>
  Effect.forEach(
    tools,
    (tool): Effect.Effect<ToolEntry, AIError> =>
      tool.type === "tool"
        ? Effect.succeed(tool)
        : collect(tool.tools, [tool.name]).pipe(
            Effect.map((leaves): ToolNamespace => ({ ...tool, tools: leaves.map((leaf) => rename(leaf, "native")) })),
          ),
  )

const lowerMessages = (messages: ReadonlyArray<Message>, style: NamespaceStyle) =>
  messages.map((message) => {
    const content = message.content.map((part) => {
      if ((part.type !== "tool-call" && part.type !== "tool-result") || part.namespace === undefined) return part
      const name = wire(part, style)
      return { ...part, namespace: name.namespace, name: name.name }
    })
    return content.every((part, index) => part === message.content[index])
      ? message
      : new Message({ ...message, content })
  })

const rename = (leaf: Leaf, style: NamespaceStyle) =>
  leaf.namespace === undefined
    ? leaf.tool
    : new ToolDefinition({ ...leaf.tool, name: wire({ namespace: leaf.namespace, name: leaf.tool.name }, style).name })

const wire = (tool: ToolName, style: NamespaceStyle): ToolName => {
  if (tool.namespace === undefined) return { name: tool.name }
  const path = tool.namespace.split(".")
  if (style === "flat") return { name: [...path, tool.name].join("_") }
  return { namespace: path[0], name: [...path.slice(1), tool.name].join("_") }
}

const key = (tool: ToolName) => (tool.namespace === undefined ? tool.name : `${tool.namespace}.${tool.name}`)

export * as ToolNames from "./tool-names.js"
