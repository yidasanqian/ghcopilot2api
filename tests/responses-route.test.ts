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
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
} from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"
import type {
  ResponsesPayload,
  ResponsesResponse,
  ResponsesStreamEvent,
} from "~/services/copilot/v2/create-responses"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

let createResponsesCalls: Array<ResponsesPayload> = []
let createMessagesCalls: Array<AnthropicMessagesPayload> = []
let createChatCompletionsCalls: Array<ChatCompletionsPayload> = []
let checkRateLimitCalls = 0
let awaitApprovalCalls = 0

interface MockSseEvent {
  data?: string
  event?: string
}

type MockSseStream = AsyncIterable<MockSseEvent>

let createResponsesImpl: (
  payload: ResponsesPayload,
) => Promise<ResponsesResponse | MockSseStream> = () =>
  Promise.reject(new Error("createResponsesImpl not configured"))

let createMessagesImpl: (
  payload: AnthropicMessagesPayload,
) => Promise<AnthropicResponse | MockSseStream> = () =>
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
  createResponsesCalls = []
  createMessagesCalls = []
  createChatCompletionsCalls = []
  checkRateLimitCalls = 0
  awaitApprovalCalls = 0

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

describe("responses route non-streaming", () => {
  test("normalizes string input for native responses requests", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "gpt-4o",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    } satisfies ModelsResponse

    const payload: ResponsesPayload = {
      model: "gpt-4o",
      input: "Hello from string input",
    }
    const upstreamResponse: ResponsesResponse = {
      id: "resp_string_1",
      model: "gpt-4o",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from responses" }],
        },
      ],
      status: "completed",
    }
    createResponsesImpl = () => Promise.resolve(upstreamResponse)

    const response = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(createResponsesCalls).toEqual([
      {
        model: "gpt-4o",
        input: [
          { type: "message", role: "user", content: "Hello from string input" },
        ],
      },
    ])
    expect((await response.json()) as ResponsesResponse).toEqual(
      upstreamResponse,
    )
  })

  test("passes through native responses for models that support /responses", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "gpt-4o",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    } satisfies ModelsResponse

    const payload: ResponsesPayload = {
      model: "gpt-4o",
      input: [{ type: "message", role: "user", content: "Hello" }],
    }
    const upstreamResponse: ResponsesResponse = {
      id: "resp_1",
      model: "gpt-4o",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from responses" }],
        },
      ],
      status: "completed",
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        total_tokens: 7,
      },
    }
    createResponsesImpl = () => Promise.resolve(upstreamResponse)

    const response = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect((await response.json()) as ResponsesResponse).toEqual(
      upstreamResponse,
    )
    expect(createResponsesCalls).toEqual([payload])
    expect(createMessagesCalls).toHaveLength(0)
    expect(createChatCompletionsCalls).toHaveLength(0)
    expect(checkRateLimitCalls).toBe(1)
    expect(awaitApprovalCalls).toBe(0)
  })

  test("translates through messages for models that prefer /v1/messages", async () => {
    state.models = {
      object: "list",
      data: [
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
          supported_endpoints: ["/v1/messages"],
          vendor: "anthropic",
        }),
      ],
    } satisfies ModelsResponse

    const payload: ResponsesPayload = {
      model: "claude-sonnet-4.5",
      input: [{ type: "message", role: "user", content: "Hello Claude" }],
    }
    createMessagesImpl = () =>
      Promise.resolve({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello from messages" }],
        model: "claude-sonnet-4.5",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 4,
        },
      })

    const response = await server.request("/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(createResponsesCalls).toHaveLength(0)
    expect(createChatCompletionsCalls).toHaveLength(0)
    expect(createMessagesCalls).toEqual([
      {
        model: "claude-sonnet-4.5",
        messages: [{ role: "user", content: "Hello Claude" }],
        max_tokens: 4096,
      },
    ])
    expect((await response.json()) as ResponsesResponse).toEqual({
      id: "msg_1",
      model: "claude-sonnet-4.5",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from messages" }],
        },
      ],
      status: "completed",
      usage: {
        input_tokens: 5,
        output_tokens: 4,
        total_tokens: 9,
      },
    })
  })
})

describe("responses route error handling", () => {
  test("forwards native responses upstream HTTP errors", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "gpt-4o",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    } satisfies ModelsResponse

    const payload: ResponsesPayload = {
      model: "gpt-4o",
      input: [{ type: "message", role: "user", content: "Hello error" }],
    }

    createResponsesImpl = () =>
      Promise.reject(
        new HTTPError(
          "Failed to create responses",
          new Response("upstream failed", { status: 429 }),
        ),
      )

    const response = await server.request("/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      error: {
        message: "upstream failed",
        type: "error",
      },
    })
    expect(createResponsesCalls).toEqual([payload])
    expect(createMessagesCalls).toHaveLength(0)
    expect(createChatCompletionsCalls).toHaveLength(0)
  })
})

describe("responses route streaming native passthrough", () => {
  test("passes through native responses stream for models that support /responses", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "gpt-4o",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    } satisfies ModelsResponse

    const payload: ResponsesPayload = {
      model: "gpt-4o",
      stream: true,
      input: [{ type: "message", role: "user", content: "Stream GPT" }],
    }

    createResponsesImpl = () =>
      Promise.resolve(
        toSseStream([
          responsesEvent({
            type: "response.created",
            response: {
              id: "resp_stream_1",
              model: "gpt-4o",
            },
          }),
          responsesEvent({
            type: "response.output_text.delta",
            output_index: 0,
            delta: "Hello native stream",
          }),
          responsesEvent({
            type: "response.completed",
            response: {
              id: "resp_stream_1",
              model: "gpt-4o",
              usage: {
                input_tokens: 4,
                output_tokens: 2,
                total_tokens: 6,
              },
            },
          }),
        ]),
      )

    const response = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(createResponsesCalls).toEqual([payload])
    expect(createMessagesCalls).toHaveLength(0)
    expect(createChatCompletionsCalls).toHaveLength(0)

    const sseEvents = parseSseEvents(await response.text())

    expect(sseEvents.map((event) => event.event)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ])
    expect(
      sseEvents.map((event) => parseSseEventData(event.data).type),
    ).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ])
    expect(parseSseEventData(sseEvents[1].data)).toMatchObject({
      type: "response.output_text.delta",
      output_index: 0,
      delta: "Hello native stream",
    })
    expect(parseSseEventData(sseEvents[2].data)).toMatchObject({
      type: "response.completed",
      response: {
        id: "resp_stream_1",
        model: "gpt-4o",
        usage: {
          input_tokens: 4,
          output_tokens: 2,
          total_tokens: 6,
        },
      },
    })
  })
})

describe("responses route streaming translated messages", () => {
  test("streams translated responses events when upstream uses /v1/messages", async () => {
    state.models = {
      object: "list",
      data: [
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
          supported_endpoints: ["/v1/messages"],
          vendor: "anthropic",
        }),
      ],
    } satisfies ModelsResponse

    const payload: ResponsesPayload = {
      model: "claude-sonnet-4.5",
      stream: true,
      input: [{ type: "message", role: "user", content: "Stream Claude" }],
    }

    createMessagesImpl = () =>
      Promise.resolve(
        toSseStream([
          anthropicEvent({
            type: "message_start",
            message: {
              id: "msg_stream_1",
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
              type: "text",
              text: "",
            },
          }),
          anthropicEvent({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "Hello stream",
            },
          }),
          anthropicEvent({
            type: "content_block_stop",
            index: 0,
          }),
          anthropicEvent({
            type: "message_delta",
            delta: {
              stop_reason: "end_turn",
              stop_sequence: null,
            },
            usage: {
              input_tokens: 8,
              output_tokens: 3,
            },
          }),
          anthropicEvent({
            type: "message_stop",
          }),
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
    expect(createChatCompletionsCalls).toHaveLength(0)
    expect(createMessagesCalls).toEqual([
      {
        model: "claude-sonnet-4.5",
        messages: [{ role: "user", content: "Stream Claude" }],
        max_tokens: 4096,
        stream: true,
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
      delta: "Hello stream",
      output_index: 0,
    })
    expect(parseSseEventData(sseEvents[4].data)).toMatchObject({
      type: "response.completed",
      response: {
        id: "msg_stream_1",
        model: "claude-sonnet-4.5",
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          total_tokens: 11,
        },
      },
    })
  })
})

describe("responses route chat completions fallback", () => {
  test("normalizes string input before falling back to chat completions", async () => {
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
      input: "Hello fallback string",
    }
    createChatCompletionsImpl = () =>
      Promise.resolve({
        id: "chatcmpl_string_1",
        object: "chat.completion",
        created: 1,
        model: "legacy-gpt",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello from chat completions",
            },
            logprobs: null,
            finish_reason: "stop",
          },
        ],
      })

    const response = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(createResponsesCalls).toHaveLength(0)
    expect(createMessagesCalls).toHaveLength(0)
    expect(createChatCompletionsCalls).toEqual([
      {
        model: "legacy-gpt",
        messages: [{ role: "user", content: "Hello fallback string" }],
      },
    ])
    expect((await response.json()) as ResponsesResponse).toEqual({
      id: "chatcmpl_string_1",
      model: "legacy-gpt",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Hello from chat completions" },
          ],
        },
      ],
      status: "completed",
    })
  })

  test("falls back to chat completions when responses and messages are unavailable", async () => {
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
      input: [{ type: "message", role: "user", content: "Hello fallback" }],
    }
    createChatCompletionsImpl = () =>
      Promise.resolve({
        id: "chatcmpl_1",
        object: "chat.completion",
        created: 1,
        model: "legacy-gpt",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello from chat completions",
            },
            logprobs: null,
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 5,
          total_tokens: 9,
        },
      })

    const response = await server.request("/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(createResponsesCalls).toHaveLength(0)
    expect(createMessagesCalls).toHaveLength(0)
    expect(createChatCompletionsCalls).toEqual([
      {
        model: "legacy-gpt",
        messages: [{ role: "user", content: "Hello fallback" }],
      },
    ])
    expect((await response.json()) as ResponsesResponse).toEqual({
      id: "chatcmpl_1",
      model: "legacy-gpt",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Hello from chat completions" },
          ],
        },
      ],
      status: "completed",
      usage: {
        input_tokens: 4,
        output_tokens: 5,
        total_tokens: 9,
      },
    })
  })
})

function anthropicEvent(event: AnthropicStreamEventData): MockSseEvent {
  return {
    event: event.type,
    data: JSON.stringify(event),
  }
}

function responsesEvent(event: ResponsesStreamEvent): MockSseEvent {
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
