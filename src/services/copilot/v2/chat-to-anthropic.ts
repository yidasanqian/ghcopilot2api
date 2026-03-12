import type {
  AnthropicAssistantContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionsPayload,
  Message,
  TextPart,
} from "~/services/copilot/create-chat-completions"

/**
 * Translate an OpenAI ChatCompletions request into an Anthropic Messages request.
 * Used when a Claude model is requested through the /chat/completions endpoint.
 */
export function translateChatToAnthropic(
  payload: ChatCompletionsPayload,
): AnthropicMessagesPayload {
  const { systemText, messages } = separateSystemMessages(payload.messages)

  const result: AnthropicMessagesPayload = {
    model: payload.model,
    messages,
    max_tokens: payload.max_tokens ?? 4096,
  }

  if (systemText) result.system = systemText
  if (payload.temperature !== null && payload.temperature !== undefined) {
    result.temperature = payload.temperature
  }
  if (payload.top_p !== null && payload.top_p !== undefined) {
    result.top_p = payload.top_p
  }
  if (payload.stop) result.stop_sequences = normalizeStop(payload.stop)
  if (payload.stream !== null && payload.stream !== undefined) {
    result.stream = payload.stream
  }
  if (payload.tools) {
    result.tools = translateOpenAIToolsToAnthropic(payload.tools)
  }
  if (payload.tool_choice !== null && payload.tool_choice !== undefined) {
    result.tool_choice = translateOpenAIToolChoiceToAnthropic(
      payload.tool_choice,
    )
  }

  return result
}

// ─── Helpers ───────────────────────────────────────────────

function normalizeStop(
  stop: string | Array<string> | null | undefined,
): Array<string> | undefined {
  if (!stop) return undefined
  if (typeof stop === "string") return [stop]
  return stop
}

function separateSystemMessages(messages: Array<Message>): {
  systemText: string
  messages: Array<AnthropicMessage>
} {
  const systemParts: Array<string> = []
  const nonSystemMessages: Array<Message> = []

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = typeof msg.content === "string" ? msg.content : ""
      if (text) systemParts.push(text)
    } else {
      nonSystemMessages.push(msg)
    }
  }

  return {
    systemText: systemParts.join("\n\n"),
    messages: convertMessagesToAnthropic(nonSystemMessages),
  }
}

function convertMessagesToAnthropic(
  messages: Array<Message>,
): Array<AnthropicMessage> {
  const result: Array<AnthropicMessage> = []
  let pendingToolResults: Array<AnthropicToolResultBlock> = []

  for (const msg of messages) {
    switch (msg.role) {
      case "user": {
        const content = convertUserContent(msg)
        if (pendingToolResults.length > 0) {
          const textBlocks = toUserContentBlocks(content)
          result.push({
            role: "user",
            content: [...pendingToolResults, ...textBlocks],
          })
          pendingToolResults = []
        } else {
          result.push({ role: "user", content })
        }
        break
      }
      case "assistant": {
        // Flush pending tool results before assistant message
        if (pendingToolResults.length > 0) {
          result.push({ role: "user", content: pendingToolResults })
          pendingToolResults = []
        }
        result.push({
          role: "assistant",
          content: convertAssistantContent(msg),
        })
        break
      }
      case "tool": {
        pendingToolResults.push({
          type: "tool_result",
          tool_use_id: msg.tool_call_id ?? "",
          content: typeof msg.content === "string" ? msg.content : "",
        })
        break
      }
      default: {
        break
      }
    }
  }

  // Flush remaining tool results
  if (pendingToolResults.length > 0) {
    result.push({ role: "user", content: pendingToolResults })
  }

  return result
}

function convertUserContent(
  msg: Message,
): string | Array<AnthropicUserContentBlock> {
  if (typeof msg.content === "string") {
    return msg.content
  }
  if (!Array.isArray(msg.content) || msg.content.length === 0) {
    return ""
  }

  const blocks: Array<AnthropicUserContentBlock> = []
  for (const part of msg.content) {
    switch (part.type) {
      case "text": {
        blocks.push({ type: "text", text: part.text })
        break
      }
      case "image_url": {
        const match = part.image_url.url.match(/^data:(.+?);base64,(.+)$/)
        if (match) {
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type:
                match[1] as AnthropicImageBlock["source"]["media_type"],
              data: match[2],
            },
          })
        }
        break
      }
      default: {
        break
      }
    }
  }
  return blocks.length > 0 ? blocks : ""
}

function toUserContentBlocks(
  content: string | Array<AnthropicUserContentBlock>,
): Array<AnthropicUserContentBlock> {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : []
  }

  return content
}

function convertAssistantContent(
  msg: Message,
): string | Array<AnthropicAssistantContentBlock> {
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    const blocks: Array<AnthropicAssistantContentBlock> = []

    // Add text content first if present
    if (typeof msg.content === "string" && msg.content) {
      blocks.push({ type: "text", text: msg.content })
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") {
          blocks.push({ type: "text", text: part.text })
        }
      }
    }

    for (const tc of msg.tool_calls) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      })
    }
    return blocks
  }

  if (typeof msg.content === "string") {
    return msg.content
  }

  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text)
      .join("")
  }

  return ""
}

function translateOpenAIToolsToAnthropic(
  tools:
    | Array<{
        type: string
        function: {
          name: string
          description?: string
          parameters: Record<string, unknown>
        }
      }>
    | null
    | undefined,
): Array<AnthropicTool> | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }))
}

function translateOpenAIToolChoiceToAnthropic(
  toolChoice: ChatCompletionsPayload["tool_choice"],
): AnthropicMessagesPayload["tool_choice"] {
  if (!toolChoice) return undefined

  if (typeof toolChoice === "string") {
    switch (toolChoice) {
      case "auto": {
        return { type: "auto" }
      }
      case "none": {
        return { type: "none" }
      }
      case "required": {
        return { type: "any" }
      }
      default: {
        return undefined
      }
    }
  }

  return {
    type: "tool",
    name: toolChoice.function.name,
  }
}
