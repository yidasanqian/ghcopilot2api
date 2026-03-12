import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type {
  AnthropicStreamEventData,
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

let createMessagesCalls: Array<AnthropicMessagesPayload> = []
let createChatCompletionsCalls: Array<ChatCompletionsPayload> = []
let getTokenCountCalls: Array<{
  model: Model
  payload: ChatCompletionsPayload
}> = []
let checkRateLimitCalls = 0
let awaitApprovalCalls = 0

interface MockSseEvent {
  data?: string
  event?: string
}

type MockSseStream = AsyncIterable<MockSseEvent>

let createMessagesImpl: (
  payload: AnthropicMessagesPayload,
) => Promise<AnthropicResponse | MockSseStream> = () =>
  Promise.reject(new Error("createMessagesImpl not configured"))

let createChatCompletionsImpl: (
  payload: ChatCompletionsPayload,
) => Promise<ChatCompletionResponse | MockSseStream> = () =>
  Promise.reject(new Error("createChatCompletionsImpl not configured"))

void mock.module("~/services/copilot/v2/create-messages", () => ({
  createMessages: (payload: AnthropicMessagesPayload) => {
    createMessagesCalls.push(payload)
    return createMessagesImpl(payload)
  },
  isAnthropicNonStreaming: (response: unknown) =>
    typeof response === "object" && response !== null && "content" in response,
}))

void mock.module("~/services/copilot/create-chat-completions", () => ({
  createChatCompletions: (payload: ChatCompletionsPayload) => {
    createChatCompletionsCalls.push(payload)
    return createChatCompletionsImpl(payload)
  },
}))

void mock.module("~/lib/tokenizer", () => ({
  getTokenCount: (
    payload: ChatCompletionsPayload,
    model: Model,
  ): Promise<number> => {
    getTokenCountCalls.push({ payload, model })
    return Promise.resolve(42)
  },
}))

void mock.module("~/lib/rate-limit", () => ({
  checkRateLimit: () => {
    checkRateLimitCalls += 1
    return Promise.resolve()
  },
}))

void mock.module("~/lib/approval", () => ({
  awaitApproval: () => {
    awaitApprovalCalls += 1
    return Promise.resolve()
  },
}))

let server: typeof import("~/server").server

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

beforeAll(async () => {
  ;({ server } = await import("~/server"))
})

afterAll(() => {
  mock.restore()
})

beforeEach(() => {
  createMessagesCalls = []
  createChatCompletionsCalls = []
  getTokenCountCalls = []
  checkRateLimitCalls = 0
  awaitApprovalCalls = 0

  createMessagesImpl = () =>
    Promise.reject(new Error("createMessagesImpl not configured"))
  createChatCompletionsImpl = () =>
    Promise.reject(new Error("createChatCompletionsImpl not configured"))

  state.manualApprove = false
  state.anthropicUseMessagesApi = true
  state.models = undefined
})

describe("chat completions route upstream HTTP errors", () => {
  test("forwards direct chat completions upstream HTTP errors", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "gpt-4o",
          capabilities: {
            family: "gpt",
            limits: { max_output_tokens: 777 },
            object: "model_capabilities",
            supports: {},
            tokenizer: "cl100k_base",
            type: "chat",
          },
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    } satisfies ModelsResponse

    const payload: ChatCompletionsPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello direct" }],
    }

    createChatCompletionsImpl = () =>
      Promise.reject(
        new HTTPError(
          "Failed to create chat completions",
          new Response("chat completions upstream failed", { status: 502 }),
        ),
      )

    const response = await server.request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: {
        message: "chat completions upstream failed",
        type: "error",
      },
    })
    expect(createChatCompletionsCalls).toEqual([
      {
        model: "gpt-4o",
        max_tokens: 777,
        messages: [{ role: "user", content: "Hello direct" }],
      },
    ])
    expect(createMessagesCalls).toHaveLength(0)
    expect(getTokenCountCalls).toHaveLength(1)
    expect(getTokenCountCalls[0]?.payload).toEqual(payload)
    expect(getTokenCountCalls[0]?.model.id).toBe("gpt-4o")
    expect(checkRateLimitCalls).toBe(1)
    expect(awaitApprovalCalls).toBe(0)
  })

  test("forwards messages upstream HTTP errors for claude models routed from chat completions", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "claude-sonnet-4.5",
          capabilities: {
            family: "claude",
            limits: { max_output_tokens: 2048 },
            object: "model_capabilities",
            supports: {},
            tokenizer: "claude",
            type: "chat",
          },
          supported_endpoints: ["/chat/completions", "/v1/messages"],
          vendor: "anthropic",
        }),
      ],
    } satisfies ModelsResponse

    const payload: ChatCompletionsPayload = {
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "Hello Claude" }],
    }

    createMessagesImpl = () =>
      Promise.reject(
        new HTTPError(
          "Failed to create messages",
          new Response("messages upstream failed", { status: 504 }),
        ),
      )

    const response = await server.request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({
      error: {
        message: "messages upstream failed",
        type: "error",
      },
    })
    expect(createMessagesCalls).toEqual([
      {
        model: "claude-sonnet-4.5",
        max_tokens: 2048,
        messages: [{ role: "user", content: "Hello Claude" }],
      },
    ])
    expect(createChatCompletionsCalls).toHaveLength(0)
    expect(getTokenCountCalls).toHaveLength(1)
    expect(getTokenCountCalls[0]?.payload).toEqual(payload)
    expect(getTokenCountCalls[0]?.model.id).toBe("claude-sonnet-4.5")
    expect(checkRateLimitCalls).toBe(1)
    expect(awaitApprovalCalls).toBe(0)
  })
})

describe("chat completions route streaming", () => {
  test("streams tool call chunks for claude models routed from chat completions", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "claude-sonnet-4.5",
          capabilities: {
            family: "claude",
            limits: { max_output_tokens: 2048 },
            object: "model_capabilities",
            supports: {},
            tokenizer: "claude",
            type: "chat",
          },
          supported_endpoints: ["/chat/completions", "/v1/messages"],
          vendor: "anthropic",
        }),
      ],
    } satisfies ModelsResponse

    const payload: ChatCompletionsPayload = {
      model: "claude-sonnet-4.5",
      stream: true,
      messages: [{ role: "user", content: "Use a tool" }],
    }

    createMessagesImpl = () =>
      Promise.resolve(
        toSseStream([
          anthropicEvent({
            type: "message_start",
            message: {
              id: "msg_tool_1",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-sonnet-4.5",
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: 8,
                output_tokens: 0,
              },
            },
          }),
          anthropicEvent({
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "toolu_1",
              name: "get_weather",
              input: {},
            },
          }),
          anthropicEvent({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: '{"city":"Bos',
            },
          }),
          anthropicEvent({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: 'ton"}',
            },
          }),
          anthropicEvent({
            type: "content_block_stop",
            index: 0,
          }),
          anthropicEvent({
            type: "message_delta",
            delta: {
              stop_reason: "tool_use",
              stop_sequence: null,
            },
            usage: {
              input_tokens: 8,
              output_tokens: 4,
            },
          }),
          anthropicEvent({
            type: "message_stop",
          }),
        ]),
      )

    const response = await server.request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(createChatCompletionsCalls).toHaveLength(0)
    expect(createMessagesCalls).toEqual([
      {
        model: "claude-sonnet-4.5",
        max_tokens: 2048,
        stream: true,
        messages: [{ role: "user", content: "Use a tool" }],
      },
    ])
    expect(getTokenCountCalls).toHaveLength(1)
    expect(getTokenCountCalls[0]?.payload).toEqual(payload)
    expect(getTokenCountCalls[0]?.model.id).toBe("claude-sonnet-4.5")

    const sseEvents = parseSseEvents(await response.text())

    expect(sseEvents.map((event) => event.data)).toHaveLength(6)
    expect(parseChatChunk(sseEvents[0].data)).toMatchObject({
      id: "msg_tool_1",
      model: "claude-sonnet-4.5",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "",
          },
          finish_reason: null,
        },
      ],
    })
    expect(parseChatChunk(sseEvents[1].data)).toMatchObject({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "toolu_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: "",
                },
              },
            ],
          },
        },
      ],
    })
    expect(parseChatChunk(sseEvents[2].data)).toMatchObject({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: '{"city":"Bos',
                },
              },
            ],
          },
        },
      ],
    })
    expect(parseChatChunk(sseEvents[3].data)).toMatchObject({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: 'ton"}',
                },
              },
            ],
          },
        },
      ],
    })
    expect(parseChatChunk(sseEvents[4].data)).toMatchObject({
      choices: [
        {
          delta: {},
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 4,
        total_tokens: 12,
      },
    })
    expect(sseEvents[5].data).toBe("[DONE]")
  })
})

function anthropicEvent(event: AnthropicStreamEventData): MockSseEvent {
  return {
    event: event.type,
    data: JSON.stringify(event),
  }
}

function toSseStream(events: Array<MockSseEvent>): MockSseStream {
  return {
    [Symbol.asyncIterator]() {
      let index = 0

      return {
        next(): Promise<IteratorResult<MockSseEvent>> {
          if (index >= events.length) {
            return Promise.resolve({ done: true, value: undefined })
          }

          const value = events[index]
          index += 1
          return Promise.resolve({ done: false, value })
        },
      }
    },
  }
}

function parseSseEvents(body: string): Array<{ data: string; event: string }> {
  return body
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const event = chunk.match(/^event: (.+)$/m)?.[1] ?? "message"
      const data = chunk.match(/^data: (.+)$/m)?.[1] ?? ""

      return { event, data }
    })
}

function parseChatChunk(data: string): ChatCompletionChunk {
  return JSON.parse(data) as ChatCompletionChunk
}
