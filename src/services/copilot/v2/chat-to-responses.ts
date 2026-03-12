import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
} from "~/services/copilot/create-chat-completions"

import { normalizeOpenAICompatibleUser } from "~/lib/utils"

import type {
  ResponsesInputContent,
  ResponsesOutputItem,
  ResponsesPayload,
  ResponsesResponse,
  ResponsesStreamEvent,
  ResponsesTool,
  ResponsesToolChoice,
  ResponsesUsage,
} from "./create-responses"

interface ToolCallDelta {
  index: number
  id?: string
  type?: "function"
  function?: {
    name?: string
    arguments?: string
  }
}

export interface ChatResponsesStreamState {
  createdSent: boolean
  model: string
  nextOutputIndex: number
  openTextOutputIndex: number | null
  responseId: string
  toolCalls: Partial<
    Record<
      number,
      {
        arguments: string
        callId: string
        name: string
        outputIndex: number
      }
    >
  >
}

export function translateChatToResponses(
  payload: ChatCompletionsPayload,
): ResponsesPayload {
  return {
    input: translateChatInput(payload.messages),
    model: payload.model,
    max_output_tokens: payload.max_tokens,
    stream: payload.stream,
    temperature: payload.temperature,
    tool_choice: translateChatToolChoice(payload.tool_choice),
    tools: translateChatTools(payload.tools),
    top_p: payload.top_p,
    user: normalizeOpenAICompatibleUser(payload.user),
  }
}

export function translateChatResponseToResponses(
  response: ChatCompletionResponse,
): ResponsesResponse {
  const output: Array<ResponsesOutputItem> = response.choices.flatMap(
    (choice) => {
      const items: Array<ResponsesOutputItem> = []

      if (choice.message.content) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: choice.message.content }],
        })
      }

      for (const toolCall of choice.message.tool_calls ?? []) {
        items.push({
          type: "function_call",
          arguments: toolCall.function.arguments,
          call_id: toolCall.id,
          name: toolCall.function.name,
        })
      }

      return items
    },
  )

  return {
    id: response.id,
    ...(response.choices.some(
      (choice) => choice.finish_reason === "length",
    ) && {
      incomplete_details: { reason: "max_output_tokens" },
      status: "incomplete",
    }),
    model: response.model,
    output,
    ...(response.choices.every(
      (choice) => choice.finish_reason !== "length",
    ) && {
      status: "completed",
    }),
    ...(response.usage && {
      usage: {
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens,
      },
    }),
  }
}

export function createChatResponsesStreamState(
  model: string,
): ChatResponsesStreamState {
  return {
    createdSent: false,
    model,
    nextOutputIndex: 0,
    openTextOutputIndex: null,
    responseId: "",
    toolCalls: {},
  }
}

export function translateChatChunkToResponsesEvents(
  chunk: ChatCompletionChunk,
  state: ChatResponsesStreamState,
): Array<ResponsesStreamEvent> {
  if (chunk.choices.length === 0) {
    return []
  }

  state.responseId ||= chunk.id
  state.model ||= chunk.model

  const events = ensureResponseCreated(state)
  const choice = chunk.choices[0]

  if (choice.delta.content) {
    events.push(...handleTextDelta(choice.delta.content, state))
  }

  if (choice.delta.tool_calls) {
    events.push(...handleToolCallDeltas(choice.delta.tool_calls, state))
  }

  if (choice.finish_reason) {
    events.push(
      ...completeResponsesStream(choice.finish_reason, chunk.usage, state),
    )
  }

  return events
}

function translateChatInput(
  messages: Array<Message>,
): ResponsesPayload["input"] {
  const input = []

  for (const message of messages) {
    switch (message.role) {
      case "tool": {
        input.push({
          type: "function_call_output" as const,
          call_id: message.tool_call_id ?? "",
          output: typeof message.content === "string" ? message.content : "",
        })
        break
      }
      case "assistant": {
        const content = mapChatContent(message.content)
        if (
          (typeof content === "string" && content)
          || Array.isArray(content)
        ) {
          input.push({
            type: "message" as const,
            role: "assistant" as const,
            content,
          })
        }

        for (const toolCall of message.tool_calls ?? []) {
          input.push({
            type: "function_call" as const,
            arguments: toolCall.function.arguments,
            call_id: toolCall.id,
            name: toolCall.function.name,
          })
        }
        break
      }
      default: {
        input.push({
          type: "message" as const,
          role: message.role,
          content: mapChatContent(message.content),
        })
        break
      }
    }
  }

  return input
}

function mapChatContent(
  content: Message["content"],
): string | Array<ResponsesInputContent> {
  if (typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return ""
  }

  return content.map((part) => mapChatPart(part))
}

function mapChatPart(part: ContentPart): ResponsesInputContent {
  switch (part.type) {
    case "text": {
      return {
        type: "input_text",
        text: part.text,
      }
    }
    case "image_url": {
      return {
        type: "input_image",
        image_url: part.image_url.url,
      }
    }
    default: {
      return {
        type: "input_text",
        text: "",
      }
    }
  }
}

function translateChatTools(
  tools: ChatCompletionsPayload["tools"],
): Array<ResponsesTool> | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }

  return tools.map((tool) => ({
    type: "function",
    description: tool.function.description,
    name: tool.function.name,
    parameters: tool.function.parameters,
  }))
}

function translateChatToolChoice(
  toolChoice: ChatCompletionsPayload["tool_choice"],
): ResponsesToolChoice | undefined {
  if (!toolChoice) {
    return undefined
  }

  if (typeof toolChoice === "string") {
    return toolChoice
  }

  return {
    type: "function",
    name: toolChoice.function.name,
  }
}

function ensureResponseCreated(
  state: ChatResponsesStreamState,
): Array<ResponsesStreamEvent> {
  if (state.createdSent) {
    return []
  }

  state.createdSent = true
  return [
    {
      type: "response.created",
      response: {
        id: state.responseId,
        model: state.model,
      },
    },
  ]
}

function handleTextDelta(
  delta: string,
  state: ChatResponsesStreamState,
): Array<ResponsesStreamEvent> {
  const events: Array<ResponsesStreamEvent> = []

  if (state.openTextOutputIndex === null) {
    state.openTextOutputIndex = state.nextOutputIndex
    state.nextOutputIndex += 1
    events.push({
      type: "response.output_item.added",
      output_index: state.openTextOutputIndex,
      item: {
        type: "message",
        role: "assistant",
        content: [],
      },
    })
  }

  events.push({
    type: "response.output_text.delta",
    delta,
    output_index: state.openTextOutputIndex,
  })

  return events
}

function handleToolCallDeltas(
  toolCalls: Array<ToolCallDelta>,
  state: ChatResponsesStreamState,
): Array<ResponsesStreamEvent> {
  const events: Array<ResponsesStreamEvent> = []

  if (state.openTextOutputIndex !== null) {
    events.push({
      type: "response.output_item.done",
      output_index: state.openTextOutputIndex,
      item: {
        type: "message",
        role: "assistant",
        content: [],
      },
    })
    state.openTextOutputIndex = null
  }

  for (const toolCall of toolCalls) {
    let toolCallState = state.toolCalls[toolCall.index]

    if (!toolCallState && toolCall.id && toolCall.function?.name) {
      toolCallState = {
        arguments: "",
        callId: toolCall.id,
        name: toolCall.function.name,
        outputIndex: state.nextOutputIndex,
      }
      state.nextOutputIndex += 1
      state.toolCalls[toolCall.index] = toolCallState

      events.push({
        type: "response.output_item.added",
        output_index: toolCallState.outputIndex,
        item: {
          type: "function_call",
          arguments: "",
          call_id: toolCallState.callId,
          name: toolCallState.name,
        },
      })
    }

    if (toolCall.function?.arguments && toolCallState) {
      toolCallState.arguments += toolCall.function.arguments
      events.push({
        type: "response.function_call_arguments.delta",
        delta: toolCall.function.arguments,
        output_index: toolCallState.outputIndex,
      })
    }
  }

  return events
}

function completeResponsesStream(
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"],
  usage: ChatCompletionChunk["usage"] | undefined,
  state: ChatResponsesStreamState,
): Array<ResponsesStreamEvent> {
  const events: Array<ResponsesStreamEvent> = []

  if (state.openTextOutputIndex !== null) {
    events.push({
      type: "response.output_item.done",
      output_index: state.openTextOutputIndex,
      item: {
        type: "message",
        role: "assistant",
        content: [],
      },
    })
    state.openTextOutputIndex = null
  }

  for (const key of Object.keys(state.toolCalls)) {
    const toolCallState = state.toolCalls[Number(key)]
    if (!toolCallState) {
      continue
    }

    events.push({
      type: "response.output_item.done",
      output_index: toolCallState.outputIndex,
      item: {
        type: "function_call",
        arguments: toolCallState.arguments,
        call_id: toolCallState.callId,
        name: toolCallState.name,
      },
    })
    state.toolCalls[Number(key)] = undefined
  }

  events.push({
    type: "response.completed",
    response: {
      id: state.responseId,
      ...(finishReason === "length" && {
        incomplete_details: {
          reason: "max_output_tokens",
        },
      }),
      model: state.model,
      ...(usage && { usage: mapUsage(usage) }),
    },
  })

  return events
}

function mapUsage(
  usage: NonNullable<ChatCompletionChunk["usage"]>,
): ResponsesUsage {
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  }
}
