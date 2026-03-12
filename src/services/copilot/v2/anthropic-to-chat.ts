import { randomUUID } from "node:crypto"

import type {
  AnthropicResponse,
  AnthropicStreamEventData,
} from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ToolCall,
} from "~/services/copilot/create-chat-completions"

// ─── Non-streaming ─────────────────────────────────────────

/**
 * Translate an Anthropic Messages response into an OpenAI ChatCompletions response.
 * Used when a Claude model is requested through the /chat/completions endpoint.
 */
export function translateAnthropicToChatResponse(
  response: AnthropicResponse,
): ChatCompletionResponse {
  const textParts: Array<string> = []
  const toolCalls: Array<ToolCall> = []

  for (const block of response.content) {
    if (block.type === "text") {
      textParts.push(block.text)
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      })
    }
  }

  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textParts.join("") || null,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        logprobs: null,
        finish_reason: mapAnthropicStopReasonToOpenAI(response.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    },
  }
}

function mapAnthropicStopReasonToOpenAI(
  stopReason: AnthropicResponse["stop_reason"],
): "stop" | "length" | "tool_calls" | "content_filter" {
  switch (stopReason) {
    case "end_turn":
    case "pause_turn":
    case "refusal":
    case "stop_sequence": {
      return "stop"
    }
    case "max_tokens": {
      return "length"
    }
    case "tool_use": {
      return "tool_calls"
    }
    default: {
      return "stop"
    }
  }
}

// ─── Streaming ─────────────────────────────────────────────

export interface ChatCompletionStreamState {
  id: string
  model: string
  created: number
  toolCalls: Partial<
    Record<number, { id: string; name: string; index: number }>
  >
  currentToolIndex: number
}

export function createStreamState(): ChatCompletionStreamState {
  return {
    id: `chatcmpl-${randomUUID()}`,
    model: "",
    created: Math.floor(Date.now() / 1000),
    toolCalls: {},
    currentToolIndex: 0,
  }
}

/**
 * Translate a single Anthropic SSE event into zero or more ChatCompletionChunk objects.
 * Used for streaming when a Claude model is requested through /chat/completions.
 */
export function translateAnthropicEventToChatChunks(
  event: AnthropicStreamEventData,
  streamState: ChatCompletionStreamState,
): Array<ChatCompletionChunk> {
  switch (event.type) {
    case "message_start": {
      return handleMessageStart(event, streamState)
    }
    case "content_block_start": {
      return handleContentBlockStart(event, streamState)
    }
    case "content_block_delta": {
      return handleContentBlockDelta(event, streamState)
    }
    case "content_block_stop": {
      return []
    }
    case "message_delta": {
      return handleMessageDelta(event, streamState)
    }
    case "message_stop":
    case "error":
    case "ping": {
      return []
    }
    default: {
      return []
    }
  }
}

function handleMessageStart(
  event: Extract<AnthropicStreamEventData, { type: "message_start" }>,
  streamState: ChatCompletionStreamState,
): Array<ChatCompletionChunk> {
  streamState.id = event.message.id
  streamState.model = event.message.model

  return [
    buildChunk(streamState, {
      delta: { role: "assistant" as const, content: "" },
      finishReason: null,
      usage: {
        prompt_tokens: event.message.usage.input_tokens,
        completion_tokens: 0,
        total_tokens: event.message.usage.input_tokens,
      },
    }),
  ]
}

function handleContentBlockStart(
  event: Extract<AnthropicStreamEventData, { type: "content_block_start" }>,
  streamState: ChatCompletionStreamState,
): Array<ChatCompletionChunk> {
  if (event.content_block.type !== "tool_use") {
    return []
  }

  const toolIndex = streamState.currentToolIndex
  streamState.toolCalls[event.index] = {
    id: event.content_block.id,
    name: event.content_block.name,
    index: toolIndex,
  }
  streamState.currentToolIndex += 1

  return [
    buildChunk(streamState, {
      delta: {
        tool_calls: [
          {
            index: toolIndex,
            id: event.content_block.id,
            type: "function" as const,
            function: {
              name: event.content_block.name,
              arguments: "",
            },
          },
        ],
      },
      finishReason: null,
    }),
  ]
}

function handleContentBlockDelta(
  event: Extract<AnthropicStreamEventData, { type: "content_block_delta" }>,
  streamState: ChatCompletionStreamState,
): Array<ChatCompletionChunk> {
  switch (event.delta.type) {
    case "text_delta": {
      return [
        buildChunk(streamState, {
          delta: { content: event.delta.text },
          finishReason: null,
        }),
      ]
    }
    case "input_json_delta": {
      const toolCallInfo = streamState.toolCalls[event.index]
      if (!toolCallInfo) {
        return []
      }

      return [
        buildChunk(streamState, {
          delta: {
            tool_calls: [
              {
                index: toolCallInfo.index,
                function: {
                  arguments: event.delta.partial_json,
                },
              },
            ],
          },
          finishReason: null,
        }),
      ]
    }
    default: {
      return []
    }
  }
}

function handleMessageDelta(
  event: Extract<AnthropicStreamEventData, { type: "message_delta" }>,
  streamState: ChatCompletionStreamState,
): Array<ChatCompletionChunk> {
  if (!event.delta.stop_reason) {
    return []
  }

  return [
    buildChunk(streamState, {
      delta: {},
      finishReason: mapAnthropicStopReasonToOpenAI(event.delta.stop_reason),
      usage: {
        prompt_tokens: event.usage?.input_tokens ?? 0,
        completion_tokens: event.usage?.output_tokens ?? 0,
        total_tokens:
          (event.usage?.input_tokens ?? 0) + (event.usage?.output_tokens ?? 0),
      },
    }),
  ]
}

function buildChunk(
  streamState: ChatCompletionStreamState,
  options: {
    delta: Record<string, unknown>
    finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null
    usage?: {
      prompt_tokens: number
      completion_tokens: number
      total_tokens: number
    }
  },
): ChatCompletionChunk {
  return {
    id: streamState.id,
    object: "chat.completion.chunk",
    created: streamState.created,
    model: streamState.model,
    choices: [
      {
        index: 0,
        delta: options.delta,
        finish_reason: options.finishReason,
        logprobs: null,
      },
    ],
    ...(options.usage && { usage: options.usage }),
  } as ChatCompletionChunk
}
