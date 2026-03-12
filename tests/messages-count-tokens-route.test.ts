import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { state } from "~/lib/state"

let getTokenCountCalls: Array<{
  model: Model
  payload: ChatCompletionsPayload
}> = []

let getTokenCountImpl: (
  payload: ChatCompletionsPayload,
  model: Model,
) => Promise<{ input: number; output: number }> = () =>
  Promise.reject(new Error("getTokenCountImpl not configured"))

function registerModuleMocks() {
  void mock.module("~/lib/tokenizer", () => ({
    getTokenCount: (payload: ChatCompletionsPayload, model: Model) => {
      getTokenCountCalls.push({ payload, model })
      return getTokenCountImpl(payload, model)
    },
  }))
}

let server: typeof import("~/server").server

const baseModel = (overrides: Partial<Model>): Model => ({
  capabilities: {
    family: "claude",
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
  vendor: "anthropic",
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
  getTokenCountCalls = []
  getTokenCountImpl = () =>
    Promise.reject(new Error("getTokenCountImpl not configured"))
  state.models = undefined
})

describe("messages count_tokens route", () => {
  test("returns default token count when model is missing", async () => {
    const response = await server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "missing-model",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hello" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ input_tokens: 1 })
    expect(getTokenCountCalls).toHaveLength(0)
  })

  test("applies Claude tool pricing and multiplier for non-MCP tools", async () => {
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
            tokenizer: "cl100k_base",
            type: "chat",
          },
        }),
      ],
    } satisfies ModelsResponse

    getTokenCountImpl = () => Promise.resolve({ input: 100, output: 20 })

    const response = await server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.5",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hello Claude" }],
        tools: [
          {
            name: "search_docs",
            input_schema: { type: "object", properties: {} },
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ input_tokens: 536 })
    expect(getTokenCountCalls).toHaveLength(1)
    expect(getTokenCountCalls[0]?.model.id).toBe("claude-sonnet-4.5")
    expect(getTokenCountCalls[0]?.payload).toMatchObject({
      model: "claude-sonnet-4.5",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello Claude" }],
      tools: [
        {
          type: "function",
          function: {
            name: "search_docs",
          },
        },
      ],
    })
  })

  test("skips Claude MCP surcharge for claude-code requests with mcp tools", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "claude-sonnet-4.5",
        }),
      ],
    } satisfies ModelsResponse

    getTokenCountImpl = () => Promise.resolve({ input: 100, output: 20 })

    const response = await server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "claude-code-1",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4.5",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hello Claude" }],
        tools: [
          {
            name: "mcp__filesystem__read_file",
            input_schema: { type: "object", properties: {} },
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ input_tokens: 138 })
    expect(getTokenCountCalls).toHaveLength(1)
  })

  test("skips Claude MCP surcharge when claude-code beta is merged with other beta values", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "claude-sonnet-4.5",
        }),
      ],
    } satisfies ModelsResponse

    getTokenCountImpl = () => Promise.resolve({ input: 100, output: 20 })

    const response = await server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "mcp-client-2025-04-04, claude-code-1",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4.5",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hello Claude" }],
        tools: [
          {
            type: "function",
            function: {
              name: "mcp__filesystem__read_file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ input_tokens: 138 })
    expect(getTokenCountCalls).toHaveLength(1)
  })

  test("returns default token count when tokenizer throws", async () => {
    state.models = {
      object: "list",
      data: [
        baseModel({
          id: "claude-sonnet-4.5",
        }),
      ],
    } satisfies ModelsResponse

    getTokenCountImpl = () => Promise.reject(new Error("tokenizer failed"))

    const response = await server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.5",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hello Claude" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ input_tokens: 1 })
    expect(getTokenCountCalls).toHaveLength(1)
  })
})
