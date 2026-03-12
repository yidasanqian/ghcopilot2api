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
} from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"
import type {
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/v2/create-responses"

import { state } from "~/lib/state"

let createMessagesCalls: Array<{
  options?: {
    extraHeaders?: Record<string, string>
  }
  payload: AnthropicMessagesPayload
}> = []
let createResponsesCalls: Array<ResponsesPayload> = []
let createChatCompletionsCalls: Array<ChatCompletionsPayload> = []
let checkRateLimitCalls = 0
let awaitApprovalCalls = 0

let createMessagesImpl: (
  payload: AnthropicMessagesPayload,
  options?: {
    extraHeaders?: Record<string, string>
  },
) => Promise<AnthropicResponse> = () =>
  Promise.reject(new Error("createMessagesImpl not configured"))

let createResponsesImpl: (
  payload: ResponsesPayload,
) => Promise<ResponsesResponse> = () =>
  Promise.reject(new Error("createResponsesImpl not configured"))

let createChatCompletionsImpl: (
  payload: ChatCompletionsPayload,
) => Promise<ChatCompletionResponse> = () =>
  Promise.reject(new Error("createChatCompletionsImpl not configured"))

void mock.module("~/services/copilot/v2/create-messages", () => ({
  createMessages: (
    payload: AnthropicMessagesPayload,
    options?: {
      extraHeaders?: Record<string, string>
    },
  ) => {
    createMessagesCalls.push({ payload, options })
    return createMessagesImpl(payload, options)
  },
  isAnthropicNonStreaming: (response: unknown) =>
    typeof response === "object" && response !== null && "content" in response,
}))

void mock.module("~/services/copilot/v2/create-responses", () => ({
  createResponses: (payload: ResponsesPayload) => {
    createResponsesCalls.push(payload)
    return createResponsesImpl(payload)
  },
  isResponsesNonStreaming: (response: unknown) =>
    typeof response === "object" && response !== null && "output" in response,
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
  createMessagesCalls = []
  createResponsesCalls = []
  createChatCompletionsCalls = []
  checkRateLimitCalls = 0
  awaitApprovalCalls = 0

  createMessagesImpl = () =>
    Promise.reject(new Error("createMessagesImpl not configured"))
  createResponsesImpl = () =>
    Promise.reject(new Error("createResponsesImpl not configured"))
  createChatCompletionsImpl = () =>
    Promise.reject(new Error("createChatCompletionsImpl not configured"))

  state.manualApprove = false
  state.anthropicUseMessagesApi = true
  state.models = undefined
})

describe("messages route validation errors", () => {
  test("returns invalid_request_error when anthropic tool name is blank", async () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        {
          name: "   ",
          input_schema: { type: "object", properties: {} },
        },
      ],
    }

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "Invalid Anthropic tools: tools[0].name is empty or missing",
        type: "invalid_request_error",
      },
    })
    expect(createMessagesCalls).toHaveLength(0)
    expect(createResponsesCalls).toHaveLength(0)
    expect(createChatCompletionsCalls).toHaveLength(0)
    expect(checkRateLimitCalls).toBe(1)
    expect(awaitApprovalCalls).toBe(0)
  })
})

describe("messages route normalization from OpenAI tools", () => {
  test("normalizes OpenAI function tools into Anthropic top-level tool definitions", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "claude-sonnet-4.6",
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

    const payload = {
      model: "claude-sonnet-4.6",
      max_tokens: 64,
      stream: true,
      user: "user_123",
      messages: [{ role: "user", content: "搜索明天杭州天气tavily" }],
      tools: [
        {
          type: "function",
          function: {
            name: "mcp__tavily_remote_mcp__tavily_search",
            description: "Search the web",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                },
              },
              required: ["query"],
            },
          },
        },
      ],
    }

    createMessagesImpl = () =>
      Promise.resolve({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4.6",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      })

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(createMessagesCalls).toEqual([
      {
        payload: {
          model: "claude-sonnet-4.6",
          max_tokens: 64,
          stream: true,
          metadata: {
            user_id: "user_123",
          },
          messages: [{ role: "user", content: "搜索明天杭州天气tavily" }],
          tools: [
            {
              name: "mcp__tavily_remote_mcp__tavily_search",
              description: "Search the web",
              input_schema: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                  },
                },
                required: ["query"],
              },
            },
          ],
        },
        options: {
          extraHeaders: {
            "anthropic-beta": "claude-code-1",
          },
        },
      },
    ])
    expect(createResponsesCalls).toHaveLength(0)
    expect(createChatCompletionsCalls).toHaveLength(0)
  })

  test("normalizes top-level OpenAI function tools with parameters into Anthropic input_schema", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "claude-sonnet-4.6",
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

    createMessagesImpl = () =>
      Promise.resolve({
        id: "msg_1b",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4.6",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      })

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Get current temperature for a given location.",
            parameters: {
              type: "object",
              properties: {
                location: {
                  type: "string",
                  description: "City and country e.g. Bogota, Colombia",
                },
              },
              required: ["location"],
              additionalProperties: false,
            },
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(createMessagesCalls.at(-1)).toEqual({
      payload: {
        model: "claude-sonnet-4.6",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "get_weather",
            description: "Get current temperature for a given location.",
            input_schema: {
              type: "object",
              properties: {
                location: {
                  type: "string",
                  description: "City and country e.g. Bogota, Colombia",
                },
              },
              required: ["location"],
              additionalProperties: false,
            },
          },
        ],
      },
      options: {
        extraHeaders: {},
      },
    })
  })
})

describe("messages route normalization from top-level custom tools", () => {
  test("normalizes nested custom tool fields into Anthropic top-level tool definition", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "claude-sonnet-4.6",
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

    const payload = {
      model: "claude-sonnet-4.6",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "custom",
          custom: {
            name: "search_docs",
            description: "Search docs",
            input_schema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                },
              },
              required: ["query"],
            },
          },
        },
      ],
    }

    createMessagesImpl = () =>
      Promise.resolve({
        id: "msg_2",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4.6",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      })

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(createMessagesCalls.at(-1)).toEqual({
      payload: {
        model: "claude-sonnet-4.6",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "custom",
            name: "search_docs",
            description: "Search docs",
            input_schema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                },
              },
              required: ["query"],
            },
          },
        ],
      },
      options: {
        extraHeaders: {},
      },
    })
  })
})

describe("messages route proxy beta headers", () => {
  test("adds claude-code beta header for beta query and mcp tools", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "claude-sonnet-4.6",
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

    createMessagesImpl = () =>
      Promise.resolve({
        id: "msg_beta_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4.6",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      })

    const response = await server.request("/v1/messages?beta=true", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "custom",
            name: "mcp__tavily-remote-mcp__tavily_search",
            description: "Search the web",
            input_schema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                },
              },
              required: ["query"],
            },
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(createMessagesCalls.at(-1)).toEqual({
      payload: {
        model: "claude-sonnet-4.6",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "custom",
            name: "mcp__tavily-remote-mcp__tavily_search",
            description: "Search the web",
            input_schema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                },
              },
              required: ["query"],
            },
          },
        ],
      },
      options: {
        extraHeaders: {
          "anthropic-beta": "claude-code-1",
          "anthropic-version": "2023-06-01",
        },
      },
    })
  })

  test("adds mcp connector beta header for mcp_servers payloads", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "claude-sonnet-4.6",
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

    createMessagesImpl = () =>
      Promise.resolve({
        id: "msg_beta_2",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4.6",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      })

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        mcp_servers: [
          {
            name: "tavily-remote-mcp",
            type: "url",
            url: "https://example.com/mcp",
            authorization_token: "test-token",
            tool_configuration: {
              enabled: true,
              allowed_tools: ["tavily_search"],
            },
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(createMessagesCalls.at(-1)).toEqual({
      payload: {
        model: "claude-sonnet-4.6",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        mcp_servers: [
          {
            name: "tavily-remote-mcp",
            type: "url",
            url: "https://example.com/mcp",
            authorization_token: "test-token",
            tool_configuration: {
              enabled: true,
              allowed_tools: ["tavily_search"],
            },
          },
        ],
      },
      options: {
        extraHeaders: {
          "anthropic-beta": "mcp-client-2025-04-04",
          "anthropic-version": "2023-06-01",
        },
      },
    })
  })
})
