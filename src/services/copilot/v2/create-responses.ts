import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { fetchWithUpstreamRetry } from "~/lib/upstream-retry"
import { normalizeOpenAICompatibleUser } from "~/lib/utils"

export interface ResponsesPayload {
  input: string | Array<ResponsesInputItem>
  model: string
  max_output_tokens?: number | null
  stream?: boolean | null
  temperature?: number | null
  tool_choice?: ResponsesToolChoice | null
  tools?: Array<ResponsesTool> | null
  top_p?: number | null
  user?: string | null
}

export type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem

export interface ResponsesInputMessage {
  type: "message"
  role: "system" | "user" | "assistant" | "developer"
  content: string | Array<ResponsesInputContent>
}

export type ResponsesInputContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }

export interface ResponsesFunctionCallItem {
  type: "function_call"
  arguments: string
  call_id: string
  name: string
}

export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string
}

export interface ResponsesTool {
  type: "function"
  description?: string
  name: string
  parameters: Record<string, unknown>
}

export type ResponsesToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; name: string }

export interface ResponsesResponse {
  id: string
  incomplete_details?: {
    reason?: string
  }
  model: string
  output: Array<ResponsesOutputItem>
  status?: string
  usage?: ResponsesUsage
}

export type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall

export interface ResponsesOutputMessage {
  type: "message"
  id?: string
  role: "assistant"
  content: Array<ResponsesOutputContent>
}

export type ResponsesOutputContent =
  | { type: "output_text"; text: string }
  | { type: "refusal"; refusal: string }

export interface ResponsesOutputFunctionCall {
  type: "function_call"
  arguments: string
  call_id: string
  id?: string
  name: string
}

export interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

export type ResponsesStreamEvent =
  | {
      type: "response.created"
      response: {
        id: string
        model: string
      }
    }
  | {
      type: "response.output_item.added"
      item: ResponsesOutputItem
      output_index: number
    }
  | {
      type: "response.output_item.done"
      item: ResponsesOutputItem
      output_index: number
    }
  | {
      type: "response.output_text.delta"
      delta: string
      output_index: number
    }
  | {
      type: "response.function_call_arguments.delta"
      delta: string
      output_index: number
    }
  | {
      type: "response.function_call_arguments.done"
      arguments: string
      output_index: number
    }
  | {
      type: "response.completed"
      response: {
        id: string
        incomplete_details?: {
          reason?: string
        }
        model: string
        usage?: ResponsesUsage
      }
    }
  | {
      type: "error"
      error: {
        message: string
        type?: string
      }
    }

export interface NormalizedResponsesPayload
  extends Omit<ResponsesPayload, "input" | "user"> {
  input: Array<ResponsesInputItem>
  user?: string
}

export function normalizeResponsesInput(
  input: ResponsesPayload["input"],
): Array<ResponsesInputItem> {
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: input }]
  }

  if (Array.isArray(input)) {
    return input
  }

  return []
}

export function normalizeResponsesPayload(
  payload: ResponsesPayload,
): NormalizedResponsesPayload {
  return {
    ...payload,
    input: normalizeResponsesInput(payload.input),
    user: normalizeOpenAICompatibleUser(payload.user),
  }
}

export const createResponses = async (payload: ResponsesPayload) => {
  if (!state.copilotToken) {
    throw new Error("Copilot token not found")
  }

  const normalizedPayload = normalizeResponsesPayload(payload)

  const headers: Record<string, string> = {
    ...copilotHeaders(state, hasVisionInput(normalizedPayload)),
    "X-Initiator": hasAgentInput(normalizedPayload) ? "agent" : "user",
  }

  const response = await fetchWithUpstreamRetry({
    exhaustedMessage: "Failed to reach upstream responses API",
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(normalizedPayload),
    },
    operationName: "responses",
    requestId: headers["x-request-id"],
    requestMetadata: {
      model: normalizedPayload.model,
      stream: normalizedPayload.stream ?? false,
      inputCount: normalizedPayload.input.length,
    },
    url: `${copilotBaseUrl(state)}/v1/responses`,
  })

  if (!response.ok) {
    const errorBody = await getResponseBodyForLog(response)

    consola.error("Failed to create responses", {
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      requestId: headers["x-request-id"],
      responseRequestId:
        response.headers.get("x-request-id")
        ?? response.headers.get("x-github-request-id"),
      model: normalizedPayload.model,
      stream: normalizedPayload.stream ?? false,
      inputCount: normalizedPayload.input.length,
      body: errorBody,
    })

    throw new HTTPError("Failed to create responses", response)
  }

  if (normalizedPayload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResponse
}

export const isResponsesNonStreaming = (
  response: Awaited<ReturnType<typeof createResponses>>,
): response is ResponsesResponse => Object.hasOwn(response as object, "output")

function hasAgentInput(payload: NormalizedResponsesPayload): boolean {
  return payload.input.some((item) => {
    if (item.type === "message") {
      return item.role === "assistant"
    }

    return true
  })
}

function hasVisionInput(payload: NormalizedResponsesPayload): boolean {
  return payload.input.some((item) => {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      return false
    }

    return item.content.some((content) => content.type === "input_image")
  })
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
