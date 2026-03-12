import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
  ToolCall,
} from "~/services/copilot/create-chat-completions"

import { normalizeOpenAICompatibleUser } from "~/lib/utils"

import {
  normalizeResponsesInput,
  type ResponsesInputContent,
  type ResponsesFunctionCallItem,
  type ResponsesInputItem,
  type ResponsesPayload,
} from "./create-responses"

export function translateResponsesToChat(
  payload: ResponsesPayload,
): ChatCompletionsPayload {
  return {
    messages: translateResponsesInput(normalizeResponsesInput(payload.input)),
    model: payload.model,
    max_tokens: payload.max_output_tokens,
    stream: payload.stream,
    temperature: payload.temperature,
    tool_choice: translateResponsesToolChoice(payload.tool_choice),
    tools: translateResponsesTools(payload.tools),
    top_p: payload.top_p,
    user: normalizeOpenAICompatibleUser(payload.user),
  }
}

function translateResponsesInput(
  input: Array<ResponsesInputItem>,
): Array<Message> {
  const messages: Array<Message> = []

  for (const item of input) {
    switch (item.type) {
      case "message": {
        messages.push({
          role: item.role,
          content: mapResponsesContent(item.content),
        })
        break
      }
      case "function_call": {
        attachToolCall(messages, item)
        break
      }
      case "function_call_output": {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: item.output,
        })
        break
      }
      default: {
        break
      }
    }
  }

  return messages
}

function mapResponsesContent(
  content: string | Array<ResponsesInputContent>,
): string | Array<ContentPart> {
  if (typeof content === "string") {
    return content
  }

  return content.map((part) => {
    switch (part.type) {
      case "input_text": {
        return {
          type: "text",
          text: part.text,
        }
      }
      case "input_image": {
        return {
          type: "image_url",
          image_url: {
            url: part.image_url,
          },
        }
      }
      default: {
        return {
          type: "text",
          text: "",
        }
      }
    }
  })
}

function attachToolCall(
  messages: Array<Message>,
  item: ResponsesFunctionCallItem,
) {
  const toolCall: ToolCall = {
    id: item.call_id,
    type: "function",
    function: {
      name: item.name,
      arguments: item.arguments,
    },
  }
  const lastMessage = messages.at(-1)

  if (lastMessage?.role === "assistant") {
    lastMessage.tool_calls = [...(lastMessage.tool_calls ?? []), toolCall]
    return
  }

  messages.push({
    role: "assistant",
    content: null,
    tool_calls: [toolCall],
  })
}

function translateResponsesTools(
  tools: ResponsesPayload["tools"],
): Array<Tool> | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

function translateResponsesToolChoice(
  toolChoice: ResponsesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] {
  if (!toolChoice) {
    return undefined
  }

  if (typeof toolChoice === "string") {
    return toolChoice
  }

  return {
    type: "function",
    function: {
      name: toolChoice.name,
    },
  }
}
