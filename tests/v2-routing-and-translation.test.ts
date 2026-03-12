import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"
import type {
  ResponsesResponse,
  ResponsesStreamEvent,
} from "~/services/copilot/v2/create-responses"

import { state } from "~/lib/state"
import { normalizeOpenAICompatibleUser } from "~/lib/utils"
import { translateAnthropicToResponses } from "~/services/copilot/v2/anthropic-to-responses"
import { translateChatToAnthropic } from "~/services/copilot/v2/chat-to-anthropic"
import {
  createChatResponsesStreamState,
  translateChatChunkToResponsesEvents,
  translateChatResponseToResponses,
} from "~/services/copilot/v2/chat-to-responses"
import {
  resolveChatCompletionsUpstreamApi,
  resolveMessagesUpstreamApi,
  resolveResponsesUpstreamApi,
} from "~/services/copilot/v2/model-router"
import {
  createResponsesAnthropicStreamState,
  translateResponsesEventToAnthropicEvents,
  translateResponsesToAnthropic,
} from "~/services/copilot/v2/responses-to-anthropic"
import { translateResponsesToChat } from "~/services/copilot/v2/responses-to-chat"

const baseModel = (overrides: Partial<Model>): Model => ({
  capabilities: {
    family: "gpt",
    limits: {},
    object: "model_capabilities",
    supports: {},
    tokenizer: "cl100k_base",
    type: "chat",
  },
  id: "model",
  model_picker_enabled: true,
  name: "Model",
  object: "model",
  preview: false,
  vendor: "openai",
  version: "1",
  ...overrides,
})

describe("v2 endpoint routing", () => {
  beforeEach(() => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "gpt-4o",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
        baseModel({
          id: "claude-sonnet-4.5",
          capabilities: {
            family: "claude",
            limits: {},
            object: "model_capabilities",
            supports: {},
            tokenizer: "claude",
            type: "chat",
          },
          vendor: "anthropic",
          supported_endpoints: ["/chat/completions", "/v1/messages"],
        }),
      ],
    } satisfies ModelsResponse
    state.anthropicUseMessagesApi = true
  })

  afterEach(() => {
    state.models = undefined
    state.anthropicUseMessagesApi = true
  })

  test("messages route prefers responses when model supports /responses", () => {
    expect(resolveMessagesUpstreamApi("gpt-4o")).toBe("responses")
  })

  test("responses route uses the same upstream selection as messages route", () => {
    expect(resolveResponsesUpstreamApi("gpt-4o")).toBe("responses")
    expect(resolveResponsesUpstreamApi("claude-sonnet-4.5")).toBe("messages")
  })

  test("chat completions route ignores responses and keeps chat completions", () => {
    expect(resolveChatCompletionsUpstreamApi("gpt-4o")).toBe("chat-completions")
  })

  test("chat completions route upgrades Claude models to messages when available", () => {
    expect(resolveChatCompletionsUpstreamApi("claude-sonnet-4.5")).toBe(
      "messages",
    )
  })
})

describe("Anthropic and Responses translation", () => {
  test("translates Anthropic messages payload into Responses payload", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      system: "You are helpful.",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will call a tool." },
            {
              type: "tool_use",
              id: "tool_1",
              name: "get_weather",
              input: { location: "Boston" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: '{"temperature":"20C"}',
            },
            { type: "text", text: "Summarize it." },
          ],
        },
      ],
      max_tokens: 256,
      tool_choice: { type: "auto" },
    }

    const translated = translateAnthropicToResponses(payload)

    expect(translated.model).toBe("gpt-4o")
    expect(translated.input[0]).toEqual({
      type: "message",
      role: "system",
      content: "You are helpful.",
    })
    expect(translated.input[2]).toEqual({
      type: "function_call",
      call_id: "tool_1",
      name: "get_weather",
      arguments: JSON.stringify({ location: "Boston" }),
    })
    expect(translated.input[3]).toEqual({
      type: "function_call_output",
      call_id: "tool_1",
      output: '{"temperature":"20C"}',
    })
    expect(translated.tool_choice).toBe("auto")
  })

  test("normalizes overlong Anthropic metadata user_id for Responses payload", () => {
    const longUserId = `user_${"a".repeat(80)}`
    const translated = translateAnthropicToResponses({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 128,
      metadata: {
        user_id: `  ${longUserId}  `,
      },
    })

    expect(translated.user).toBe(normalizeOpenAICompatibleUser(longUserId))
    expect(translated.user).toHaveLength(64)
    expect(translated.user).toMatch(/^user_a+-[0-9a-f]{16}$/)
  })

  test("translates Responses response into Anthropic message response", () => {
    const response: ResponsesResponse = {
      id: "resp_1",
      model: "gpt-4o",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from responses." }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"location":"Boston"}',
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
    }

    const translated = translateResponsesToAnthropic(response)

    expect(translated.stop_reason).toBe("tool_use")
    expect(translated.content[0]).toEqual({
      type: "text",
      text: "Hello from responses.",
    })
    expect(translated.content[1]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "get_weather",
      input: { location: "Boston" },
    })
  })

  test("translates Responses stream events into Anthropic stream events", () => {
    const streamState = createResponsesAnthropicStreamState("gpt-4o")
    const stream: Array<ResponsesStreamEvent> = [
      {
        type: "response.created",
        response: {
          id: "resp_stream_1",
          model: "gpt-4o",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          role: "assistant",
          content: [],
        },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        delta: "Hello",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          role: "assistant",
          content: [],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_stream_1",
          model: "gpt-4o",
          usage: {
            input_tokens: 8,
            output_tokens: 2,
            total_tokens: 10,
          },
        },
      },
    ]

    const translated = stream.flatMap((event) =>
      translateResponsesEventToAnthropicEvents(event, streamState),
    )

    expect(translated.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
  })
})

describe("Chat completions and Anthropic translation", () => {
  test("translates developer/system history into Anthropic system prompt", () => {
    const translated = translateChatToAnthropic({
      model: "claude-sonnet-4.5",
      messages: [
        { role: "developer", content: "Developer rule" },
        { role: "system", content: "System rule" },
        { role: "user", content: "Hello" },
      ],
    })

    expect(translated.system).toBe("Developer rule\n\nSystem rule")
    expect(translated.messages).toEqual([{ role: "user", content: "Hello" }])
  })
})

describe("Responses and Chat Completions translation", () => {
  test("translates Responses input into Chat Completions messages", () => {
    const translated = translateResponsesToChat({
      input: [
        {
          type: "message",
          role: "system",
          content: "You are helpful.",
        },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Look at this image" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,abc",
            },
          ],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"location":"Boston"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: '{"temperature":"20C"}',
        },
      ],
      model: "gpt-4o",
    })

    expect(translated.messages[0]).toEqual({
      role: "system",
      content: "You are helpful.",
    })
    expect(translated.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Look at this image" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,abc" },
        },
      ],
    })
    expect(translated.messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "get_weather",
            arguments: '{"location":"Boston"}',
          },
        },
      ],
    })
    expect(translated.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: '{"temperature":"20C"}',
    })
  })

  test("translates Chat Completions response into Responses response", () => {
    const translated = translateChatResponseToResponses({
      id: "chatcmpl_1",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello from chat completions.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"location":"Boston"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    })

    expect(translated.output).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Hello from chat completions." },
        ],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"location":"Boston"}',
      },
    ])
  })

  test("translates Chat Completions stream chunks into Responses stream events", () => {
    const streamState = createChatResponsesStreamState("gpt-4o")
    const events = [
      {
        id: "chatcmpl_1",
        object: "chat.completion.chunk" as const,
        created: 1,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" as const },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "chatcmpl_1",
        object: "chat.completion.chunk" as const,
        created: 1,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: { content: "Hello" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "chatcmpl_1",
        object: "chat.completion.chunk" as const,
        created: 1,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop" as const,
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 2,
          total_tokens: 10,
        },
      },
    ].flatMap((chunk) =>
      translateChatChunkToResponsesEvents(chunk, streamState),
    )

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ])
  })
})
