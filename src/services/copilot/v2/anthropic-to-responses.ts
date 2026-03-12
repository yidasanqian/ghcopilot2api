import type {
  AnthropicAssistantMessage,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicUserContentBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUserMessage,
} from "~/routes/messages/anthropic-types"

import { normalizeOpenAICompatibleUser } from "~/lib/utils"
import {
  getAnthropicToolDescription,
  getAnthropicToolInputSchema,
  getAnthropicToolName,
} from "~/routes/messages/non-stream-translation"

import type {
  ResponsesFunctionCallOutputItem,
  ResponsesInputContent,
  ResponsesInputItem,
  ResponsesPayload,
  ResponsesTool,
  ResponsesToolChoice,
} from "./create-responses"

export function translateAnthropicToResponses(
  payload: AnthropicMessagesPayload,
): ResponsesPayload {
  return {
    input: translateAnthropicInput(payload),
    model: payload.model,
    max_output_tokens: payload.max_tokens,
    stream: payload.stream,
    temperature: payload.temperature,
    tools: translateAnthropicTools(payload.tools),
    tool_choice: translateAnthropicToolChoice(payload.tool_choice),
    top_p: payload.top_p,
    user: normalizeOpenAICompatibleUser(payload.metadata?.user_id),
  }
}

function translateAnthropicInput(
  payload: AnthropicMessagesPayload,
): Array<ResponsesInputItem> {
  const items: Array<ResponsesInputItem> = []

  if (payload.system) {
    items.push({
      type: "message",
      role: "system",
      content: flattenSystemText(payload.system),
    })
  }

  for (const message of payload.messages) {
    items.push(...translateAnthropicMessage(message))
  }

  return items
}

function flattenSystemText(system: string | Array<AnthropicTextBlock>): string {
  if (typeof system === "string") {
    return system
  }

  return system.map((block) => block.text).join("\n\n")
}

function translateAnthropicMessage(
  message: AnthropicMessage,
): Array<ResponsesInputItem> {
  if (message.role === "user") {
    return translateAnthropicUserMessage(message)
  }

  return translateAnthropicAssistantMessage(message)
}

function translateAnthropicUserMessage(
  message: AnthropicUserMessage,
): Array<ResponsesInputItem> {
  if (!Array.isArray(message.content)) {
    return [
      {
        type: "message",
        role: "user",
        content: message.content,
      },
    ]
  }

  const items: Array<ResponsesInputItem> = []
  const toolResults = message.content.filter(
    (block): block is AnthropicToolResultBlock => block.type === "tool_result",
  )
  const userContent = message.content.filter(
    (block) => block.type !== "tool_result",
  )

  for (const toolResult of toolResults) {
    items.push(translateToolResult(toolResult))
  }

  const content = translateUserContent(userContent)
  if (content.length > 0) {
    items.push({
      type: "message",
      role: "user",
      content,
    })
  }

  return items
}

function translateAnthropicAssistantMessage(
  message: AnthropicAssistantMessage,
): Array<ResponsesInputItem> {
  if (!Array.isArray(message.content)) {
    return [
      {
        type: "message",
        role: "assistant",
        content: message.content,
      },
    ]
  }

  const items: Array<ResponsesInputItem> = []
  const text = message.content
    .filter(
      (block): block is AnthropicTextBlock | AnthropicThinkingBlock =>
        block.type === "text" || block.type === "thinking",
    )
    .map((block) => (block.type === "text" ? block.text : block.thinking))
    .join("\n\n")

  if (text) {
    items.push({
      type: "message",
      role: "assistant",
      content: text,
    })
  }

  for (const toolUse of message.content.filter(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use",
  )) {
    items.push({
      type: "function_call",
      arguments: JSON.stringify(toolUse.input),
      call_id: toolUse.id,
      name: toolUse.name,
    })
  }

  return items
}

function translateToolResult(
  block: AnthropicToolResultBlock,
): ResponsesFunctionCallOutputItem {
  return {
    type: "function_call_output",
    call_id: block.tool_use_id,
    output: block.content,
  }
}

function translateUserContent(
  blocks: Array<AnthropicUserContentBlock>,
): Array<ResponsesInputContent> {
  const content: Array<ResponsesInputContent> = []

  for (const block of blocks) {
    switch (block.type) {
      case "text": {
        content.push({
          type: "input_text",
          text: block.text,
        })
        break
      }
      case "image": {
        content.push({
          type: "input_image",
          image_url: toDataUrl(block),
        })
        break
      }
      default: {
        break
      }
    }
  }

  return content
}

function toDataUrl(block: AnthropicImageBlock): string {
  return `data:${block.source.media_type};base64,${block.source.data}`
}

function translateAnthropicTools(
  tools: AnthropicMessagesPayload["tools"],
): Array<ResponsesTool> | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }

  return tools.map((tool) => ({
    type: "function",
    description: getAnthropicToolDescription(tool),
    name: getAnthropicToolName(tool) ?? "",
    parameters: getAnthropicToolInputSchema(tool),
  }))
}

function translateAnthropicToolChoice(
  toolChoice: AnthropicMessagesPayload["tool_choice"],
): ResponsesToolChoice | undefined {
  if (!toolChoice) {
    return undefined
  }

  switch (toolChoice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "none": {
      return "none"
    }
    case "tool": {
      return toolChoice.name ?
          { type: "function", name: toolChoice.name }
        : undefined
    }
    default: {
      return undefined
    }
  }
}
