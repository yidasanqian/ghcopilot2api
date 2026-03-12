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
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"
import type {
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/v2/create-responses"

import { state } from "~/lib/state"

let createResponsesCalls: Array<ResponsesPayload> = []
let createMessagesCalls: Array<unknown> = []
let createChatCompletionsCalls: Array<ChatCompletionsPayload> = []

interface MockSseEvent {
  data?: string
  event?: string
}

type MockSseStream = AsyncIterable<MockSseEvent>

let createResponsesImpl: (
  payload: ResponsesPayload,
) => Promise<ResponsesResponse | MockSseStream> = () =>
  Promise.reject(new Error("createResponsesImpl not configured"))

let createMessagesImpl: () => Promise<unknown> = () =>
  Promise.reject(new Error("createMessagesImpl not configured"))

let createChatCompletionsImpl: (
  payload: ChatCompletionsPayload,
) => Promise<ChatCompletionResponse | MockSseStream> = () =>
  Promise.reject(new Error("createChatCompletionsImpl not configured"))

const normalizeResponsesInput = (input: ResponsesPayload["input"]) => {
  if (typeof input === "string") {
    return [{ type: "message" as const, role: "user" as const, content: input }]
  }

  return input
}

function registerModuleMocks() {
  void mock.module("~/services/copilot/v2/create-responses", () => ({
    createResponses: (payload: ResponsesPayload) => {
      createResponsesCalls.push(payload)
      return createResponsesImpl(payload)
    },
    isResponsesNonStreaming: (response: unknown) =>
      typeof response === "object" && response !== null && "output" in response,
    normalizeResponsesInput,
    normalizeResponsesPayload: (payload: ResponsesPayload) => ({
      ...payload,
      input: normalizeResponsesInput(payload.input),
      user: payload.user ?? undefined,
    }),
  }))

  void mock.module("~/services/copilot/v2/create-messages", () => ({
    createMessages: () => {
      createMessagesCalls.push({ called: true })
      return createMessagesImpl()
    },
    isAnthropicNonStreaming: (response: unknown) =>
      typeof response === "object"
      && response !== null
      && "content" in response,
  }))

  void mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: (payload: ChatCompletionsPayload) => {
      createChatCompletionsCalls.push(payload)
      return createChatCompletionsImpl(payload)
    },
  }))

  void mock.module("~/lib/rate-limit", () => ({
    checkRateLimit: () => Promise.resolve(),
  }))

  void mock.module("~/lib/approval", () => ({
    awaitApproval: () => Promise.resolve(),
  }))
}

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
  registerModuleMocks()
  ;({ server } = await import("~/server"))
  mock.restore()
})

afterAll(() => {
  mock.restore()
})

beforeEach(() => {
  createResponsesCalls = []
  createMessagesCalls = []
  createChatCompletionsCalls = []

  createResponsesImpl = () =>
    Promise.reject(new Error("createResponsesImpl not configured"))
  createMessagesImpl = () =>
    Promise.reject(new Error("createMessagesImpl not configured"))
  createChatCompletionsImpl = () =>
    Promise.reject(new Error("createChatCompletionsImpl not configured"))

  state.manualApprove = false
  state.anthropicUseMessagesApi = true
  state.models = undefined
})

describe("responses route chat completions fallback streaming", () => {
  test("streams translated responses events when falling back to chat completions", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "legacy-gpt",
          supported_endpoints: ["/chat/completions"],
        }),
      ],
    } satisfies ModelsResponse

    const payload: ResponsesPayload = {
      model: "legacy-gpt",
      stream: true,
      input: [{ type: "message", role: "user", content: "Stream fallback" }],
    }

    createChatCompletionsImpl = () =>
      Promise.resolve(
        toSseStream([
          chatChunkEvent({
            id: "chatcmpl_stream_1",
            object: "chat.completion.chunk",
            created: 1,
            model: "legacy-gpt",
            choices: [
              {
                index: 0,
                delta: { role: "assistant" },
                finish_reason: null,
                logprobs: null,
              },
            ],
          }),
          chatChunkEvent({
            id: "chatcmpl_stream_1",
            object: "chat.completion.chunk",
            created: 1,
            model: "legacy-gpt",
            choices: [
              {
                index: 0,
                delta: { content: "Hello fallback stream" },
                finish_reason: null,
                logprobs: null,
              },
            ],
          }),
          chatChunkEvent({
            id: "chatcmpl_stream_1",
            object: "chat.completion.chunk",
            created: 1,
            model: "legacy-gpt",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
                logprobs: null,
              },
            ],
            usage: {
              prompt_tokens: 6,
              completion_tokens: 3,
              total_tokens: 9,
            },
          }),
          { data: "[DONE]" },
        ]),
      )

    const response = await server.request("/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(createResponsesCalls).toHaveLength(0)
    expect(createMessagesCalls).toHaveLength(0)
    expect(createChatCompletionsCalls).toEqual([
      {
        model: "legacy-gpt",
        stream: true,
        messages: [{ role: "user", content: "Stream fallback" }],
      },
    ])

    const sseEvents = parseSseEvents(await response.text())

    expect(sseEvents.map((event) => event.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ])
    expect(
      sseEvents.map((event) => parseSseEventData(event.data).type),
    ).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ])
    expect(parseSseEventData(sseEvents[2].data)).toMatchObject({
      type: "response.output_text.delta",
      output_index: 0,
      delta: "Hello fallback stream",
    })
    expect(parseSseEventData(sseEvents[4].data)).toMatchObject({
      type: "response.completed",
      response: {
        id: "chatcmpl_stream_1",
        model: "legacy-gpt",
        usage: {
          input_tokens: 6,
          output_tokens: 3,
          total_tokens: 9,
        },
      },
    })
  })
})

describe("responses route chat completions fallback tool calls", () => {
  test("streams tool call event chains when falling back to chat completions", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "legacy-gpt",
          supported_endpoints: ["/chat/completions"],
        }),
      ],
    } satisfies ModelsResponse

    const payload: ResponsesPayload = {
      model: "legacy-gpt",
      stream: true,
      input: [{ type: "message", role: "user", content: "Use a tool" }],
    }

    createChatCompletionsImpl = () =>
      Promise.resolve(
        toSseStream([
          chatChunkEvent({
            id: "chatcmpl_tool_1",
            object: "chat.completion.chunk",
            created: 1,
            model: "legacy-gpt",
            choices: [
              {
                index: 0,
                delta: { role: "assistant" },
                finish_reason: null,
                logprobs: null,
              },
            ],
          }),
          chatChunkEvent({
            id: "chatcmpl_tool_1",
            object: "chat.completion.chunk",
            created: 1,
            model: "legacy-gpt",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "get_weather",
                        arguments: "",
                      },
                    },
                  ],
                },
                finish_reason: null,
                logprobs: null,
              },
            ],
          }),
          chatChunkEvent({
            id: "chatcmpl_tool_1",
            object: "chat.completion.chunk",
            created: 1,
            model: "legacy-gpt",
            choices: [
              {
                index: 0,
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
                finish_reason: null,
                logprobs: null,
              },
            ],
          }),
          chatChunkEvent({
            id: "chatcmpl_tool_1",
            object: "chat.completion.chunk",
            created: 1,
            model: "legacy-gpt",
            choices: [
              {
                index: 0,
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
                finish_reason: null,
                logprobs: null,
              },
            ],
          }),
          chatChunkEvent({
            id: "chatcmpl_tool_1",
            object: "chat.completion.chunk",
            created: 1,
            model: "legacy-gpt",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "tool_calls",
                logprobs: null,
              },
            ],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 4,
              total_tokens: 11,
            },
          }),
          { data: "[DONE]" },
        ]),
      )

    const response = await server.request("/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(createResponsesCalls).toHaveLength(0)
    expect(createMessagesCalls).toHaveLength(0)
    expect(createChatCompletionsCalls).toEqual([
      {
        model: "legacy-gpt",
        stream: true,
        messages: [{ role: "user", content: "Use a tool" }],
      },
    ])

    const sseEvents = parseSseEvents(await response.text())

    expect(sseEvents.map((event) => event.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.output_item.done",
      "response.completed",
    ])
    expect(parseSseEventData(sseEvents[1].data)).toMatchObject({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: "",
      },
    })
    expect(parseSseEventData(sseEvents[2].data)).toMatchObject({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: '{"city":"Bos',
    })
    expect(parseSseEventData(sseEvents[3].data)).toMatchObject({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: 'ton"}',
    })
    expect(parseSseEventData(sseEvents[4].data)).toMatchObject({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"Boston"}',
      },
    })
    expect(parseSseEventData(sseEvents[5].data)).toMatchObject({
      type: "response.completed",
      response: {
        id: "chatcmpl_tool_1",
        model: "legacy-gpt",
        usage: {
          input_tokens: 7,
          output_tokens: 4,
          total_tokens: 11,
        },
      },
    })
  })
})

function chatChunkEvent(event: ChatCompletionChunk): MockSseEvent {
  return {
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

function parseSseEventData(data: string): Record<string, unknown> & {
  type: string
} {
  const parsed: unknown = JSON.parse(data)

  if (
    typeof parsed !== "object"
    || parsed === null
    || !("type" in parsed)
    || typeof parsed.type !== "string"
  ) {
    throw new Error("Invalid SSE event payload")
  }

  return parsed as Record<string, unknown> & { type: string }
}
