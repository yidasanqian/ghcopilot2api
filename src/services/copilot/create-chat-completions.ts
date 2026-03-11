import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const selectedModel = state.models?.data.find((model) => model.id === payload.model)
  const toolDiagnostics = getToolDiagnostics(payload.tools)

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  // Build headers and add X-Initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
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
      model: payload.model,
      modelSupportsToolCalls: selectedModel?.capabilities.supports.tool_calls,
      stream: payload.stream ?? false,
      messageCount: payload.messages.length,
      messageRoles: payload.messages.map((message) => message.role),
      hasTools: (payload.tools?.length ?? 0) > 0,
      toolChoice: payload.tool_choice ?? null,
      toolDiagnostics,
      body: errorBody,
    })

    throw new HTTPError("Failed to create chat completions", response)
  }

  if (payload.stream) {
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

  const invalidNamePattern = /^[A-Za-z0-9_-]{1,64}$/
  const invalidNames: string[] = []
  const nonObjectSchemas: string[] = []
  const schemaWithoutProperties: string[] = []

  for (const tool of tools) {
    const toolName = tool.function.name
    const parameters = tool.function.parameters
    const schemaType =
      typeof parameters === "object" && parameters !== null && "type" in parameters ?
        parameters.type
        : undefined

    if (!invalidNamePattern.test(toolName)) {
      invalidNames.push(toolName)
    }

    if (schemaType !== "object") {
      nonObjectSchemas.push(toolName)
    }

    if (
      schemaType === "object"
      && typeof parameters === "object"
      && parameters !== null
      && !("properties" in parameters)
    ) {
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

async function getResponseBodyForLog(response: Response): Promise<unknown> {
  try {
    const responseText = await response.clone().text()

    if (!responseText) {
      return null
    }

    try {
      return JSON.parse(responseText) as unknown
    } catch {
      return responseText
    }
  } catch (error) {
    return {
      failedToReadBody: true,
      error: error instanceof Error ? error.message : String(error),
    }
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
