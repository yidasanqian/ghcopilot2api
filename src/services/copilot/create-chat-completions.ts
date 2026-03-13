import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import {
  getResponseBodyForLog,
  getResponseHeadersForLog,
} from "~/lib/upstream-log"
import { fetchWithUpstreamRetry } from "~/lib/upstream-retry"
import { normalizeOpenAICompatibleUser } from "~/lib/utils"
import { resolveInitiator } from "~/services/copilot/resolve-initiator"

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const normalizedPayload: ChatCompletionsPayload = {
    ...payload,
    user: normalizeOpenAICompatibleUser(payload.user),
  }

  const selectedModel = state.models?.data.find(
    (model) => model.id === normalizedPayload.model,
  )
  const toolDiagnostics = getToolDiagnostics(normalizedPayload.tools)

  const enableVision = normalizedPayload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Build headers and add X-Initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": resolveInitiator(normalizedPayload.messages),
  }

  const response = await fetchWithUpstreamRetry({
    exhaustedMessage: "Failed to reach upstream chat completions API",
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(normalizedPayload),
    },
    operationName: "chat completions",
    requestId: headers["x-request-id"],
    requestMetadata: {
      model: normalizedPayload.model,
      stream: normalizedPayload.stream ?? false,
      messageCount: normalizedPayload.messages.length,
      hasTools: (normalizedPayload.tools?.length ?? 0) > 0,
      toolChoice: normalizedPayload.tool_choice ?? null,
    },
    url: `${copilotBaseUrl(state)}/chat/completions`,
  })

  if (!response.ok) {
    const errorBody = await getResponseBodyForLog(response)

    consola.error("Failed to create chat completions", {
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      requestId: headers["x-request-id"],
      responseRequestId:
        response.headers.get("x-request-id")
        ?? response.headers.get("x-github-request-id"),
      model: normalizedPayload.model,
      modelSupportsToolCalls: selectedModel?.capabilities.supports.tool_calls,
      stream: normalizedPayload.stream ?? false,
      messageCount: normalizedPayload.messages.length,
      messageRoles: normalizedPayload.messages.map((message) => message.role),
      hasTools: (normalizedPayload.tools?.length ?? 0) > 0,
      toolChoice: normalizedPayload.tool_choice ?? null,
      toolDiagnostics,
      responseHeaders: getResponseHeadersForLog(response),
      body: errorBody,
    })

    throw new HTTPError("Failed to create chat completions", response)
  }

  if (normalizedPayload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

function getToolDiagnostics(tools: Array<Tool> | null | undefined) {
  if (!tools || tools.length === 0) {
    return {
      toolCount: 0,
    }
  }

  const invalidNamePattern = /^[\w-]{1,64}$/
  const invalidNames: Array<string> = []
  const nonObjectSchemas: Array<string> = []
  const schemaWithoutProperties: Array<string> = []

  for (const tool of tools) {
    const toolName = tool.function.name
    const parameters = tool.function.parameters
    const schemaType = "type" in parameters ? parameters.type : undefined

    if (!invalidNamePattern.test(toolName)) {
      invalidNames.push(toolName)
    }

    if (schemaType !== "object") {
      nonObjectSchemas.push(toolName)
    }

    if (schemaType === "object" && !("properties" in parameters)) {
      schemaWithoutProperties.push(toolName)
    }
  }

  return {
    toolCount: tools.length,
    toolNamesPreview: tools.slice(0, 10).map((tool) => tool.function.name),
    invalidNames,
    nonObjectSchemas,
    schemaWithoutProperties,
  }
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
