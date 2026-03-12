import { randomUUID } from "node:crypto"

import type {
  AnthropicAssistantContentBlock,
  AnthropicResponse,
  AnthropicStreamEventData,
} from "~/routes/messages/anthropic-types"

import type {
  ResponsesOutputFunctionCall,
  ResponsesOutputItem,
  ResponsesOutputMessage,
  ResponsesResponse,
  ResponsesStreamEvent,
  ResponsesUsage,
} from "./create-responses"

interface OutputBlockState {
  anthropicBlockIndex: number
  type: "text" | "tool_use"
}

export interface ResponsesAnthropicStreamState {
  messageId: string
  messageStartSent: boolean
  model: string
  nextBlockIndex: number
  outputBlocks: Partial<Record<number, OutputBlockState>>
  sawRefusal: boolean
  sawToolUse: boolean
}

export function translateResponsesToAnthropic(
  response: ResponsesResponse,
): AnthropicResponse {
  const content: Array<AnthropicAssistantContentBlock> = []
  let sawRefusal = false
  let sawToolUse = false

  for (const item of response.output) {
    if (item.type === "message") {
      for (const block of item.content) {
        if (block.type === "output_text") {
          content.push({ type: "text", text: block.text })
        } else {
          sawRefusal = true
          content.push({ type: "text", text: block.refusal })
        }
      }
      continue
    }

    sawToolUse = true
    content.push({
      type: "tool_use",
      id: item.call_id,
      name: item.name,
      input: safeParseJson(item.arguments),
    })
  }

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    content,
    model: response.model,
    stop_reason: resolveResponsesStopReason(response, sawToolUse, sawRefusal),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  }
}

export function createResponsesAnthropicStreamState(
  model: string,
): ResponsesAnthropicStreamState {
  return {
    messageId: `msg_${randomUUID()}`,
    messageStartSent: false,
    model,
    nextBlockIndex: 0,
    outputBlocks: {},
    sawRefusal: false,
    sawToolUse: false,
  }
}

export function translateResponsesEventToAnthropicEvents(
  event: ResponsesStreamEvent,
  state: ResponsesAnthropicStreamState,
): Array<AnthropicStreamEventData> {
  switch (event.type) {
    case "response.created": {
      state.messageId = event.response.id
      state.model = event.response.model
      return []
    }
    case "response.output_item.added": {
      return handleOutputItemAdded(event.output_index, event.item, state)
    }
    case "response.output_text.delta": {
      return handleOutputTextDelta(event.output_index, event.delta, state)
    }
    case "response.function_call_arguments.delta": {
      return handleFunctionArgumentsDelta(
        event.output_index,
        event.delta,
        state,
      )
    }
    case "response.function_call_arguments.done": {
      return handleFunctionArgumentsDone(
        event.output_index,
        event.arguments,
        state,
      )
    }
    case "response.output_item.done": {
      return closeOutputBlock(event.output_index, state)
    }
    case "response.completed": {
      return completeResponse(
        event.response.usage,
        event.response.incomplete_details?.reason,
        state,
      )
    }
    case "error": {
      return [
        {
          type: "error",
          error: {
            type: event.error.type ?? "api_error",
            message: event.error.message,
          },
        },
      ]
    }
    default: {
      return []
    }
  }
}

function handleOutputItemAdded(
  outputIndex: number,
  item: ResponsesOutputItem,
  state: ResponsesAnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events = ensureMessageStart(state)

  if (item.type === "message") {
    events.push(
      ...ensureTextBlock(outputIndex, state),
      ...emitPrefilledMessageContent(item, outputIndex, state),
    )
    return events
  }

  state.sawToolUse = true
  events.push(...ensureToolBlock(outputIndex, item, state))
  if (item.arguments.length > 0) {
    const outputBlock = state.outputBlocks[outputIndex]
    if (!outputBlock) {
      return events
    }

    events.push({
      type: "content_block_delta",
      index: outputBlock.anthropicBlockIndex,
      delta: {
        type: "input_json_delta",
        partial_json: item.arguments,
      },
    })
  }

  return events
}

function handleOutputTextDelta(
  outputIndex: number,
  delta: string,
  state: ResponsesAnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events = ensureMessageStart(state)
  const textBlockEvents = ensureTextBlock(outputIndex, state)
  const outputBlock = state.outputBlocks[outputIndex]
  if (!outputBlock) {
    return events
  }

  events.push(...textBlockEvents, {
    type: "content_block_delta",
    index: outputBlock.anthropicBlockIndex,
    delta: {
      type: "text_delta",
      text: delta,
    },
  })
  return events
}

function handleFunctionArgumentsDelta(
  outputIndex: number,
  delta: string,
  state: ResponsesAnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const outputBlock = state.outputBlocks[outputIndex]
  if (!outputBlock || outputBlock.type !== "tool_use") {
    return []
  }

  return [
    {
      type: "content_block_delta",
      index: outputBlock.anthropicBlockIndex,
      delta: {
        type: "input_json_delta",
        partial_json: delta,
      },
    },
  ]
}

function handleFunctionArgumentsDone(
  outputIndex: number,
  argumentsText: string,
  state: ResponsesAnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const outputBlock = state.outputBlocks[outputIndex]
  if (
    !outputBlock
    || outputBlock.type !== "tool_use"
    || argumentsText.length === 0
  ) {
    return []
  }

  return [
    {
      type: "content_block_delta",
      index: outputBlock.anthropicBlockIndex,
      delta: {
        type: "input_json_delta",
        partial_json: argumentsText,
      },
    },
  ]
}

function closeOutputBlock(
  outputIndex: number,
  state: ResponsesAnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const outputBlock = state.outputBlocks[outputIndex]
  if (!outputBlock) {
    return []
  }

  state.outputBlocks[outputIndex] = undefined
  return [
    {
      type: "content_block_stop",
      index: outputBlock.anthropicBlockIndex,
    },
  ]
}

function completeResponse(
  usage: ResponsesUsage | undefined,
  incompleteReason: string | undefined,
  state: ResponsesAnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events = ensureMessageStart(state, usage)

  for (const outputIndex of Object.keys(state.outputBlocks)) {
    events.push(...closeOutputBlock(Number(outputIndex), state))
  }

  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: resolveStreamingStopReason(incompleteReason, state),
        stop_sequence: null,
      },
      usage: {
        input_tokens: usage?.input_tokens,
        output_tokens: usage?.output_tokens ?? 0,
      },
    },
    {
      type: "message_stop",
    },
  )

  return events
}

function ensureMessageStart(
  state: ResponsesAnthropicStreamState,
  usage?: ResponsesUsage,
): Array<AnthropicStreamEventData> {
  if (state.messageStartSent) {
    return []
  }

  state.messageStartSent = true
  return [
    {
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: state.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage?.input_tokens ?? 0,
          output_tokens: 0,
        },
      },
    },
  ]
}

function ensureTextBlock(
  outputIndex: number,
  state: ResponsesAnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const existing = state.outputBlocks[outputIndex]
  if (existing) {
    return []
  }

  const anthropicBlockIndex = state.nextBlockIndex
  state.nextBlockIndex += 1
  state.outputBlocks[outputIndex] = {
    anthropicBlockIndex,
    type: "text",
  }

  return [
    {
      type: "content_block_start",
      index: anthropicBlockIndex,
      content_block: {
        type: "text",
        text: "",
      },
    },
  ]
}

function ensureToolBlock(
  outputIndex: number,
  item: ResponsesOutputFunctionCall,
  state: ResponsesAnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const existing = state.outputBlocks[outputIndex]
  if (existing) {
    return []
  }

  const anthropicBlockIndex = state.nextBlockIndex
  state.nextBlockIndex += 1
  state.outputBlocks[outputIndex] = {
    anthropicBlockIndex,
    type: "tool_use",
  }

  return [
    {
      type: "content_block_start",
      index: anthropicBlockIndex,
      content_block: {
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: {},
      },
    },
  ]
}

function emitPrefilledMessageContent(
  item: ResponsesOutputMessage,
  outputIndex: number,
  state: ResponsesAnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []
  const outputBlock = state.outputBlocks[outputIndex]
  if (!outputBlock) {
    return events
  }

  for (const content of item.content) {
    if (content.type === "output_text") {
      events.push({
        type: "content_block_delta",
        index: outputBlock.anthropicBlockIndex,
        delta: {
          type: "text_delta",
          text: content.text,
        },
      })
    } else {
      state.sawRefusal = true
      events.push({
        type: "content_block_delta",
        index: outputBlock.anthropicBlockIndex,
        delta: {
          type: "text_delta",
          text: content.refusal,
        },
      })
    }
  }

  return events
}

function resolveResponsesStopReason(
  response: ResponsesResponse,
  sawToolUse: boolean,
  sawRefusal: boolean,
): AnthropicResponse["stop_reason"] {
  if (response.incomplete_details?.reason === "max_output_tokens") {
    return "max_tokens"
  }

  if (sawToolUse) {
    return "tool_use"
  }

  if (sawRefusal) {
    return "refusal"
  }

  return "end_turn"
}

function resolveStreamingStopReason(
  incompleteReason: string | undefined,
  state: ResponsesAnthropicStreamState,
): AnthropicResponse["stop_reason"] {
  if (incompleteReason === "max_output_tokens") {
    return "max_tokens"
  }

  if (state.sawToolUse) {
    return "tool_use"
  }

  if (state.sawRefusal) {
    return "refusal"
  }

  return "end_turn"
}

function safeParseJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}
