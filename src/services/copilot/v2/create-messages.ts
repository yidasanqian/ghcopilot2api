import consola from "consola"
import { events } from "fetch-event-stream"

import type {
  AnthropicTool,
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import {
  getResponseBodyForLog,
  getRequestHeadersForLog,
  getResponseHeadersForLog,
} from "~/lib/upstream-log"
import { fetchWithUpstreamRetry } from "~/lib/upstream-retry"

interface CreateMessagesOptions {
  extraHeaders?: Record<string, string>
}

interface SanitizedMessagesPayload {
  payload: AnthropicMessagesPayload
  removedKeys: Array<string>
}

const STREAM_CONNECTION_RETRY_WINDOW_MS = 1000

type FetchMessagesWithRetry = (options: {
  exhaustedMessage: string
  init: RequestInit
  operationName: string
  requestId?: string
  requestMetadata?: Record<string, unknown>
  retryConnectionErrorWindowMs?: number
  url: string
  maxAttempts?: number
}) => Promise<Response>

const fetchWithSharedRetry = fetchWithUpstreamRetry as FetchMessagesWithRetry

export const createMessages = async (
  payload: AnthropicMessagesPayload,
  options: CreateMessagesOptions = {},
) => {
  if (!state.copilotToken) {
    throw new Error("Copilot token not found")
  }

  const { payload: upstreamPayload, removedKeys } =
    stripUnsupportedMessagesFields(payload)

  const headers: Record<string, string> = {
    ...copilotHeaders(state, hasVisionContent(payload)),
    "X-Initiator": hasAgentHistory(payload) ? "agent" : "user",
    ...options.extraHeaders,
  }

  consola.debug("Native messages upstream request:", {
    url: `${copilotBaseUrl(state)}/v1/messages`,
    headers: getUpstreamMessagesLogHeaders(headers),
    removedKeys,
    payload: getMessagesRequestPreview(upstreamPayload),
  })

  const response = await fetchMessagesWithRetry(upstreamPayload, headers)

  if (!response.ok) {
    const errorBody = await getResponseBodyForLog(response)
    const requestPayloadJson = JSON.stringify(upstreamPayload)

    consola.error("Failed to create messages", {
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      requestId: headers["x-request-id"],
      responseRequestId:
        response.headers.get("x-request-id")
        ?? response.headers.get("x-github-request-id"),
      model: payload.model,
      stream: payload.stream ?? false,
      messageCount: payload.messages.length,
      removedKeys,
      requestHeaders: getRequestHeadersForLog(headers),
      responseHeaders: getResponseHeadersForLog(response),
      body: errorBody,
    })
    consola.error(
      "Failed to create messages request payload",
      requestPayloadJson,
    )

    throw new HTTPError("Failed to create messages", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as AnthropicResponse
}

export const isAnthropicNonStreaming = (
  response: Awaited<ReturnType<typeof createMessages>>,
): response is AnthropicResponse => Object.hasOwn(response as object, "content")

function hasAgentHistory(payload: AnthropicMessagesPayload): boolean {
  return payload.messages.some((message) => message.role === "assistant")
}

function hasVisionContent(payload: AnthropicMessagesPayload): boolean {
  return payload.messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some((block) => block.type === "image"),
  )
}

function fetchMessagesWithRetry(
  payload: AnthropicMessagesPayload,
  headers: Record<string, string>,
): Promise<Response> {
  return fetchWithSharedRetry({
    exhaustedMessage: "Failed to reach upstream messages API",
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
    operationName: "messages",
    requestId: headers["x-request-id"],
    requestMetadata: {
      model: payload.model,
      stream: payload.stream ?? false,
      messageCount: payload.messages.length,
    },
    retryConnectionErrorWindowMs:
      payload.stream ? STREAM_CONNECTION_RETRY_WINDOW_MS : undefined,
    url: `${copilotBaseUrl(state)}/v1/messages`,
  })
}

function stripUnsupportedMessagesFields(
  payload: AnthropicMessagesPayload,
): SanitizedMessagesPayload {
  const { context_management: _contextManagement, ...sanitizedPayload } =
    payload as AnthropicMessagesPayload & {
      context_management?: unknown
    }

  return {
    payload: sanitizedPayload,
    removedKeys: _contextManagement === undefined ? [] : ["context_management"],
  }
}

function getUpstreamMessagesLogHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const logHeaders: Record<string, string> = {}

  for (const name of [
    "anthropic-beta",
    "anthropic-version",
    "x-interaction-id",
    "x-request-id",
    "x-initiator",
  ]) {
    const value = headers[name] ?? headers[name.toLowerCase()]
    if (value) {
      logHeaders[name] = value
    }
  }

  return logHeaders
}

function getMessagesRequestPreview(payload: AnthropicMessagesPayload) {
  return {
    model: payload.model,
    stream: payload.stream ?? false,
    messageCount: payload.messages.length,
    metadataUserId: payload.metadata?.user_id,
    toolCount: payload.tools?.length ?? 0,
    tools: payload.tools?.slice(0, 10).map((tool) => ({
      type: typeof tool.type === "string" ? tool.type : undefined,
      name: getToolName(tool),
      compatibilityCustomName: getCompatibilityCustomName(tool),
      serverName:
        typeof tool.server_name === "string" ? tool.server_name : undefined,
      serverToolName:
        typeof tool.server_tool_name === "string" ?
          tool.server_tool_name
        : undefined,
    })),
    mcpServerCount: payload.mcp_servers?.length ?? 0,
    mcpServers: payload.mcp_servers?.slice(0, 10).map((server) => ({
      name: server.name,
      type: server.type,
      url: server.url,
      allowedTools: server.tool_configuration?.allowed_tools,
    })),
  }
}

function getToolName(tool: AnthropicTool): string | undefined {
  if (typeof tool.name === "string" && tool.name) {
    return tool.name
  }

  const compatibilityCustomName = getCompatibilityCustomName(tool)
  if (compatibilityCustomName) {
    return compatibilityCustomName
  }

  const openAIFunction = tool.function
  if (
    typeof openAIFunction === "object"
    && openAIFunction !== null
    && "name" in openAIFunction
    && typeof openAIFunction.name === "string"
    && openAIFunction.name
  ) {
    return openAIFunction.name
  }

  if (
    typeof tool.server_name === "string"
    && typeof tool.server_tool_name === "string"
  ) {
    return `mcp__${tool.server_name}__${tool.server_tool_name}`
  }

  return undefined
}

function getCompatibilityCustomName(tool: AnthropicTool): string | undefined {
  const customTool = tool["custom"]

  if (
    typeof customTool === "object"
    && customTool !== null
    && "name" in customTool
    && typeof customTool.name === "string"
    && customTool.name
  ) {
    return customTool.name
  }

  return undefined
}
