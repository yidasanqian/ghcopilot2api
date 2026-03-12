import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { RequestValidationError } from "~/lib/error"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { translateAnthropicToResponses } from "~/services/copilot/v2/anthropic-to-responses"
import {
  createMessages,
  isAnthropicNonStreaming,
} from "~/services/copilot/v2/create-messages"
import {
  createResponses,
  isResponsesNonStreaming,
  type ResponsesStreamEvent,
} from "~/services/copilot/v2/create-responses"
import { resolveMessagesUpstreamApi } from "~/services/copilot/v2/model-router"
import {
  createResponsesAnthropicStreamState,
  translateResponsesEventToAnthropicEvents,
  translateResponsesToAnthropic,
} from "~/services/copilot/v2/responses-to-anthropic"

import {
  type AnthropicTool,
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  getAnthropicToolDescription,
  getAnthropicToolInputSchema,
  getAnthropicToolName,
  normalizeAnthropicPayload,
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = normalizeAnthropicPayload(
    await c.req.json<AnthropicMessagesPayload>(),
  )
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))
  logAnthropicToolPreview(anthropicPayload)
  validateAnthropicTools(anthropicPayload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  switch (resolveMessagesUpstreamApi(anthropicPayload.model)) {
    case "messages": {
      return handleNativeMessages(c, anthropicPayload)
    }
    case "responses": {
      return handleResponsesTranslated(c, anthropicPayload)
    }
    case "chat-completions": {
      return handleChatCompletionsTranslated(c, anthropicPayload)
    }
    default: {
      return handleChatCompletionsTranslated(c, anthropicPayload)
    }
  }
}

async function handleNativeMessages(
  c: Context,
  payload: AnthropicMessagesPayload,
) {
  const response = await createMessages(payload, {
    extraHeaders: getAnthropicProxyHeaders(c, payload),
  })

  if (isAnthropicNonStreaming(response)) {
    consola.debug(
      "Non-streaming Anthropic response:",
      JSON.stringify(response).slice(-400),
    )
    return c.json(response)
  }

  consola.debug("Streaming Anthropic response (passthrough)")
  return streamSSE(c, async (stream) => {
    for await (const rawEvent of response) {
      if (!rawEvent.data) {
        continue
      }

      await stream.writeSSE({
        event: rawEvent.event ?? "message",
        data: rawEvent.data,
      })
    }
  })
}

async function handleResponsesTranslated(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
) {
  const responsesPayload = translateAnthropicToResponses(anthropicPayload)
  consola.debug(
    "Translated Responses request payload:",
    JSON.stringify(responsesPayload),
  )

  const response = await createResponses(responsesPayload)

  if (isResponsesNonStreaming(response)) {
    const anthropicResponse = translateResponsesToAnthropic(response)
    consola.debug(
      "Translated Anthropic response from Responses API:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  return streamSSE(c, async (stream) => {
    const streamState = createResponsesAnthropicStreamState(
      anthropicPayload.model,
    )

    for await (const rawEvent of response) {
      if (!rawEvent.data || rawEvent.data === "[DONE]") {
        continue
      }

      const event = JSON.parse(rawEvent.data) as ResponsesStreamEvent
      const events = translateResponsesEventToAnthropicEvents(
        event,
        streamState,
      )

      for (const translatedEvent of events) {
        await stream.writeSSE({
          event: translatedEvent.type,
          data: JSON.stringify(translatedEvent),
        })
      }
    }
  })
}

async function handleChatCompletionsTranslated(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
) {
  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

function logAnthropicToolPreview(payload: AnthropicMessagesPayload) {
  if (!payload.tools || payload.tools.length === 0) {
    return
  }

  consola.debug("Anthropic tools preview:", {
    toolCount: payload.tools.length,
    tools: payload.tools.slice(0, 10).map((tool, index) => ({
      index,
      type: typeof tool.type === "string" ? tool.type : undefined,
      rawKeys: Object.keys(tool).slice(0, 10),
      customKeys: getToolCustomKeys(tool),
      name: getAnthropicToolName(tool),
      description: getAnthropicToolDescription(tool),
      schemaType:
        "type" in getAnthropicToolInputSchema(tool) ?
          getAnthropicToolInputSchema(tool).type
        : undefined,
      schemaKeys: Object.keys(getAnthropicToolInputSchema(tool)).slice(0, 10),
    })),
  })
}

function validateAnthropicTools(payload: AnthropicMessagesPayload) {
  if (!payload.tools || payload.tools.length === 0) {
    return
  }

  for (const [index, tool] of payload.tools.entries()) {
    const name = getAnthropicToolName(tool)?.trim()

    if (!name) {
      throw new RequestValidationError(
        `Invalid Anthropic tools: tools[${index}].name is empty or missing`,
      )
    }
  }
}

function getAnthropicProxyHeaders(
  c: Context,
  payload: AnthropicMessagesPayload,
): Record<string, string> {
  const headers: Record<string, string> = {}

  for (const headerName of ["anthropic-beta", "anthropic-version"]) {
    const headerValue = c.req.header(headerName)
    if (headerValue) {
      headers[headerName] = headerValue
    }
  }

  const betaRequested = c.req.query("beta") === "true"
  const hasMcpTool = payload.tools?.some(
    (tool) => getAnthropicToolName(tool)?.startsWith("mcp__") ?? false,
  )
  const hasMcpServer = Boolean(payload.mcp_servers?.length)

  if (betaRequested || hasMcpTool) {
    headers["anthropic-beta"] = mergeAnthropicBetaHeaders(
      headers["anthropic-beta"],
      "claude-code-1",
    )
  }

  if (hasMcpServer) {
    headers["anthropic-beta"] = mergeAnthropicBetaHeaders(
      headers["anthropic-beta"],
      "mcp-client-2025-04-04",
    )
  }

  return headers
}

function mergeAnthropicBetaHeaders(
  existingHeader: string | undefined,
  requiredValue: string,
): string {
  if (!existingHeader) {
    return requiredValue
  }

  const values = existingHeader
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  if (!values.includes(requiredValue)) {
    values.push(requiredValue)
  }

  return values.join(",")
}

function getToolCustomKeys(tool: AnthropicTool): Array<string> {
  const customTool = tool["custom"]

  if (typeof customTool !== "object" || customTool === null) {
    return []
  }

  return Object.keys(customTool).slice(0, 10)
}
