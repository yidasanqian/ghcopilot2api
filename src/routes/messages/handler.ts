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

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  getAnthropicToolDescription,
  getAnthropicToolInputSchema,
  getAnthropicToolName,
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))
  logAnthropicToolPreview(anthropicPayload)
  validateAnthropicTools(anthropicPayload)

  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

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
      customKeys:
        typeof tool.custom === "object" && tool.custom !== null ?
          Object.keys(tool.custom as Record<string, unknown>).slice(0, 10)
          : [],
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
