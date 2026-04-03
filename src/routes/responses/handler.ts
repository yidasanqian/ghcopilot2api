import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { copilotBaseUrl } from "~/lib/api-config"
import { awaitApproval } from "~/lib/approval"
import { setUpstreamRequestLogUrl } from "~/lib/logging"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import {
  createStreamState,
  translateAnthropicEventToChatChunks,
  translateAnthropicToChatResponse,
} from "~/services/copilot/v2/anthropic-to-chat"
import { translateChatToAnthropic } from "~/services/copilot/v2/chat-to-anthropic"
import {
  createChatResponsesStreamState,
  translateChatChunkToResponsesEvents,
  translateChatResponseToResponses,
} from "~/services/copilot/v2/chat-to-responses"
import {
  createMessages,
  isAnthropicNonStreaming,
} from "~/services/copilot/v2/create-messages"
import {
  createResponses,
  isResponsesNonStreaming,
  normalizeResponsesPayload,
  type ResponsesPayload,
} from "~/services/copilot/v2/create-responses"
import { resolveResponsesUpstreamApi } from "~/services/copilot/v2/model-router"
import { translateResponsesToChat } from "~/services/copilot/v2/responses-to-chat"

import type { AnthropicStreamEventData } from "../messages/anthropic-types"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const payload = normalizeResponsesPayload(
    await c.req.json<ResponsesPayload>(),
  )
  consola.debug(
    "Responses request payload:",
    JSON.stringify(payload).slice(-400),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  switch (resolveResponsesUpstreamApi(payload.model)) {
    case "responses": {
      return handleNativeResponses(c, payload)
    }
    case "messages": {
      return handleMessagesTranslated(c, payload)
    }
    case "chat-completions": {
      return handleChatCompletionsTranslated(c, payload)
    }
    default: {
      return handleChatCompletionsTranslated(c, payload)
    }
  }
}

async function handleNativeResponses(c: Context, payload: ResponsesPayload) {
  setUpstreamRequestLogUrl(c, `${copilotBaseUrl(state)}/v1/responses`)
  const response = await createResponses(payload)

  if (isResponsesNonStreaming(response)) {
    return c.json(response)
  }

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

async function handleMessagesTranslated(c: Context, payload: ResponsesPayload) {
  setUpstreamRequestLogUrl(c, `${copilotBaseUrl(state)}/v1/messages`)
  const anthropicPayload = translateChatToAnthropic(
    translateResponsesToChat(payload),
  )
  const response = await createMessages(anthropicPayload)

  if (isAnthropicNonStreaming(response)) {
    return c.json(
      translateChatResponseToResponses(
        translateAnthropicToChatResponse(response),
      ),
    )
  }

  return streamSSE(c, async (stream) => {
    const anthropicStreamState = createStreamState()
    const responsesStreamState = createChatResponsesStreamState(payload.model)

    for await (const rawEvent of response) {
      if (!rawEvent.data) {
        continue
      }

      const event = JSON.parse(rawEvent.data) as AnthropicStreamEventData
      const chatChunks = translateAnthropicEventToChatChunks(
        event,
        anthropicStreamState,
      )

      for (const chunk of chatChunks) {
        const translatedEvents = translateChatChunkToResponsesEvents(
          chunk,
          responsesStreamState,
        )

        for (const translatedEvent of translatedEvents) {
          await stream.writeSSE({
            event: translatedEvent.type,
            data: JSON.stringify(translatedEvent),
          })
        }
      }
    }
  })
}

async function handleChatCompletionsTranslated(
  c: Context,
  payload: ResponsesPayload,
) {
  setUpstreamRequestLogUrl(c, `${copilotBaseUrl(state)}/chat/completions`)
  const chatPayload = translateResponsesToChat(payload)
  const response = await createChatCompletions(chatPayload)

  if (isChatNonStreaming(response)) {
    return c.json(translateChatResponseToResponses(response))
  }

  return streamSSE(c, async (stream) => {
    const streamState = createChatResponsesStreamState(payload.model)

    for await (const rawEvent of response) {
      if (!rawEvent.data || rawEvent.data === "[DONE]") {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChatChunkToResponsesEvents(chunk, streamState)

      for (const event of events) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

function isChatNonStreaming(
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse {
  return Object.hasOwn(response, "choices")
}
