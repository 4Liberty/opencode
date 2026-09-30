import { Effect } from "effect"
import { LLMRequest, Message, ToolDefinition, type LLMEvent, type ToolEntry } from "./schema/index.js"
import { ProviderShared } from "./protocols/shared.js"

/**
 * How a protocol receives tool namespaces. Callers always use the declared
 * path, e.g. `{ namespace: "crm.orders", name: "list" }`: flat protocols see
 * `crm_orders_list`, native ones see `{ namespace: "crm", name: "orders_list" }`.
 */
export type NamespaceStyle = "flat" | "native"

interface Name {
  readonly namespace?: string
  readonly name: string
}

/** Lower declared tool names to wire names; `raise` maps tool events back. */
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
  return {
    request: LLMRequest.update(request, {
      // Native namespaces are one level deep, so deeper levels join into the leaf name.
      tools:
        style === "flat"
          ? flatten(request.tools)
          : request.tools.map((tool) => (tool.type === "tool" ? tool : { ...tool, tools: flatten(tool.tools) })),
      messages: request.messages.map((msg) => {
        const content = msg.content.map((part) =>
          (part.type === "tool-call" || part.type === "tool-result") && part.namespace
            ? { ...part, ...wire(part, style) }
            : part,
        )
        return content.some((part, i) => part !== msg.content[i]) ? new Message({ ...msg, content }) : msg
      }),
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
): Array<{ path: ReadonlyArray<string>; tool: ToolDefinition }> =>
  tools.flatMap((tool) => (tool.type === "tool" ? [{ path, tool }] : walk(tool.tools, [...path, tool.name])))

const flatten = (tools: ReadonlyArray<ToolEntry>) =>
  walk(tools).map((leaf) =>
    leaf.path.length ? new ToolDefinition({ ...leaf.tool, name: [...leaf.path, leaf.tool.name].join("_") }) : leaf.tool,
  )

const wire = (tool: Name, style: NamespaceStyle): Name => {
  const path = tool.namespace?.split(".") ?? []
  if (style === "native" && path.length) return { namespace: path[0], name: [...path.slice(1), tool.name].join("_") }
  return { namespace: undefined, name: [...path, tool.name].join("_") }
}

const id = (tool: Name) => (tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name)

export * as ToolNames from "./tool-names.js"
