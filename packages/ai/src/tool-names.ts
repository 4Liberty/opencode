import { Effect } from "effect"
import {
  LLMRequest,
  Message,
  ToolDefinition,
  type ContentPart,
  type LLMEvent,
  type ToolCallPart,
  type ToolEntry,
  type ToolResultPart,
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

interface Name {
  readonly namespace?: string
  readonly name: string
}

/** Lower declared tool names to wire names, and return `raise` to map tool events back. */
export const lower = Effect.fn("ToolNames.lower")(function* (request: LLMRequest, style: NamespaceStyle) {
  const names = new Map<string, Name>()
  for (const leaf of walk(request.tools)) {
    const bad = leaf.path.find((part) => part.includes("."))
    if (bad !== undefined) return yield* ProviderShared.invalidRequest(`Tool namespace "${bad}" must not contain "."`)
    const name = { namespace: leaf.path.join(".") || undefined, name: leaf.tool.name }
    const key = id(wire(name, style))
    const taken = names.get(key)
    if (taken)
      return yield* ProviderShared.invalidRequest(
        `Tools "${id(taken)}" and "${id(name)}" both use the provider tool name "${key}"`,
      )
    names.set(key, name)
  }

  const named = (part: ContentPart): part is ToolCallPart | ToolResultPart =>
    (part.type === "tool-call" || part.type === "tool-result") && part.namespace !== undefined

  return {
    request: LLMRequest.update(request, {
      // Native namespaces are one level deep, so deeper levels join into the leaf name.
      tools:
        style === "flat"
          ? flatten(request.tools)
          : request.tools.map((tool) => (tool.type === "tool" ? tool : { ...tool, tools: flatten(tool.tools) })),
      messages: request.messages.map((msg) =>
        msg.content.some(named)
          ? new Message({
              ...msg,
              content: msg.content.map((part) => (named(part) ? { ...part, ...wire(part, style) } : part)),
            })
          : msg,
      ),
    }),
    raise: (event: LLMEvent): LLMEvent => {
      const name = "name" in event ? names.get(id(event)) : undefined
      return name ? { ...event, ...name } : event
    },
  }
})

const walk = (
  tools: ReadonlyArray<ToolEntry>,
  path: ReadonlyArray<string> = [],
): Array<{ readonly path: ReadonlyArray<string>; readonly tool: ToolDefinition }> =>
  tools.flatMap((tool) => (tool.type === "tool" ? [{ path, tool }] : walk(tool.tools, [...path, tool.name])))

const flatten = (tools: ReadonlyArray<ToolEntry>) =>
  walk(tools).map((leaf) =>
    leaf.path.length === 0
      ? leaf.tool
      : new ToolDefinition({ ...leaf.tool, name: [...leaf.path, leaf.tool.name].join("_") }),
  )

const wire = (tool: Name, style: NamespaceStyle): Name => {
  const path = tool.namespace?.split(".") ?? []
  if (style === "native" && path.length > 0)
    return { namespace: path[0], name: [...path.slice(1), tool.name].join("_") }
  return { namespace: undefined, name: [...path, tool.name].join("_") }
}

const id = (tool: Name) => (tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name)

export * as ToolNames from "./tool-names.js"
