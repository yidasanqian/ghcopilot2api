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

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { normalizeOpenAICompatibleUser } from "~/lib/utils"

let createMessagesCalls: Array<{
  options?: {
    extraHeaders?: Record<string, string>
  }
  payload: AnthropicMessagesPayload
}> = []
let createResponsesCalls: Array<ResponsesPayload> = []
let createChatCompletionsCalls: Array<ChatCompletionsPayload> = []

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
  checkRateLimit: () => Promise.resolve(),
}))

void mock.module("~/lib/approval", () => ({
  awaitApproval: () => Promise.resolve(),
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

describe("messages route upstream HTTP errors", () => {
  test("forwards native messages upstream HTTP errors", async () => {
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

    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello native" }],
    }

    createMessagesImpl = () =>
      Promise.reject(
        new HTTPError(
          "Failed to create messages",
          new Response("messages upstream failed", { status: 503 }),
        ),
      )

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "claude-code-1",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: {
        message: "messages upstream failed",
        type: "error",
      },
    })
    expect(createMessagesCalls).toEqual([
      {
        payload,
        options: {
          extraHeaders: {
            "anthropic-beta": "claude-code-1",
            "anthropic-version": "2023-06-01",
          },
        },
      },
    ])
    expect(createResponsesCalls).toHaveLength(0)
    expect(createChatCompletionsCalls).toHaveLength(0)
  })

  test("forwards responses upstream HTTP errors for gpt models requested via /v1/messages", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "gpt-4o",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    } satisfies ModelsResponse

    const payload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello responses" }],
    }

    createResponsesImpl = () =>
      Promise.reject(
        new HTTPError(
          "Failed to create responses",
          new Response("responses upstream failed", { status: 429 }),
        ),
      )

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      error: {
        message: "responses upstream failed",
        type: "error",
      },
    })
    expect(createResponsesCalls).toEqual([
      {
        model: "gpt-4o",
        max_output_tokens: 64,
        input: [{ type: "message", role: "user", content: "Hello responses" }],
      },
    ])
    expect(createMessagesCalls).toHaveLength(0)
    expect(createChatCompletionsCalls).toHaveLength(0)
  })
})

describe("messages route upstream fallback handling", () => {
  test("normalizes overlong metadata.user_id before calling responses for gpt models", async () => {
    const longUserId = `user_508c27fb1d9b7e990da87fb2aee277ed25e04784482177841f0e0b9d12a4d83f_account__session_30b736c2-eae9-4282-8933-cebf4fb8097f`

    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "gpt-5.4",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    } satisfies ModelsResponse

    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 64,
      stream: true,
      metadata: {
        user_id: longUserId,
      },
      messages: [{ role: "user", content: "搜索明天杭州天气tavily" }],
    }

    createResponsesImpl = () =>
      Promise.resolve({
        id: "resp_1",
        model: "gpt-5.4",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
        status: "completed",
      })

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(createResponsesCalls).toHaveLength(1)
    expect(createResponsesCalls[0]).toMatchObject({
      model: "gpt-5.4",
      max_output_tokens: 64,
      stream: true,
      user: normalizeOpenAICompatibleUser(longUserId),
      input: [
        {
          type: "message",
          role: "user",
          content: "搜索明天杭州天气tavily",
        },
      ],
    })
    expect(createResponsesCalls[0]?.user).toHaveLength(64)
    expect(createMessagesCalls).toHaveLength(0)
    expect(createChatCompletionsCalls).toHaveLength(0)
  })

  test("forwards chat completions upstream HTTP errors for fallback models", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "legacy-gpt",
          supported_endpoints: ["/chat/completions"],
        }),
      ],
    } satisfies ModelsResponse

    const payload: AnthropicMessagesPayload = {
      model: "legacy-gpt",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello fallback" }],
    }

    createChatCompletionsImpl = () =>
      Promise.reject(
        new HTTPError(
          "Failed to create chat completions",
          new Response("chat upstream failed", { status: 500 }),
        ),
      )

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: {
        message: "chat upstream failed",
        type: "error",
      },
    })
    expect(createChatCompletionsCalls).toEqual([
      {
        model: "legacy-gpt",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hello fallback" }],
      },
    ])
    expect(createMessagesCalls).toHaveLength(0)
    expect(createResponsesCalls).toHaveLength(0)
  })
})
