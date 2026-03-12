import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import {
  createStreamState,
  translateAnthropicEventToChatChunks,
  translateAnthropicToChatResponse,
} from "~/services/copilot/v2/anthropic-to-chat"
import { translateChatToAnthropic } from "~/services/copilot/v2/chat-to-anthropic"
import {
  createMessages,
  isAnthropicNonStreaming,
} from "~/services/copilot/v2/create-messages"
import { resolveChatCompletionsUpstreamApi } from "~/services/copilot/v2/model-router"

import type { AnthropicStreamEventData } from "../messages/anthropic-types"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info("Current token count:", tokenCount)
    } else {
      consola.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  if (resolveChatCompletionsUpstreamApi(payload.model) === "messages") {
    return handleMessagesTranslated(c, payload)
  }

  const response = await createChatCompletions(payload)

  if (isNonStreaming(response)) {
    consola.debug("Non-streaming response:", JSON.stringify(response))
    return c.json(response)
  }

  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      consola.debug("Streaming chunk:", JSON.stringify(chunk))
      await stream.writeSSE(chunk as SSEMessage)
    }
  })
}

async function handleMessagesTranslated(
  c: Context,
  payload: ChatCompletionsPayload,
) {
  const anthropicPayload = translateChatToAnthropic(payload)
  const response = await createMessages(anthropicPayload)

  if (isAnthropicNonStreaming(response)) {
    return c.json(translateAnthropicToChatResponse(response))
  }

  return streamSSE(c, async (stream) => {
    const streamState = createStreamState()

    for await (const rawEvent of response) {
      if (!rawEvent.data || rawEvent.data === "[DONE]") {
        continue
      }

      const event = JSON.parse(rawEvent.data) as AnthropicStreamEventData
      const chunks = translateAnthropicEventToChatChunks(event, streamState)

      for (const chunk of chunks) {
        await stream.writeSSE({
          data: JSON.stringify(chunk),
        })
      }
    }

    await stream.writeSSE({ data: "[DONE]" })
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
