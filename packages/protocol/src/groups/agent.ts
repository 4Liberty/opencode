import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location.js"
import { AgentNotFoundError } from "../errors.js"

export const AgentGroup = HttpApiGroup.make("server.agent")
  .add(
    HttpApiEndpoint.get("agent.list", "/api/agent", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Agent.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "agent.list",
          summary: "List agents",
          description: "Retrieve currently registered agents.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("agent.default", "/api/agent/default", {
      query: LocationQuery,
      success: Location.response(Schema.UndefinedOr(Agent.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "agent.default",
          summary: "Get default agent",
          description:
            "Retrieve the agent used when a session has no explicit agent selection. The result may precede initial plugin and config settlement.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("agent.get", "/api/agent/:agentID", {
      params: { agentID: Agent.ID },
      query: LocationQuery,
      success: Location.response(Agent.Info),
      error: AgentNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "agent.get",
          summary: "Get agent",
          description: "Retrieve a single currently registered agent.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "agent" }))
