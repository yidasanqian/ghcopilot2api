import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import consola from "consola"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { HTTPError, UpstreamConnectionError } from "~/lib/error"
import { state } from "~/lib/state"

mock.restore()

const { createMessages } = await import(
  "../src/services/copilot/v2/create-messages"
)

const originalFetch = globalThis.fetch
const originalDateNow = Date.now
const originalConsolaDebug = consola.debug
const originalConsolaError = consola.error

const basePayload: AnthropicMessagesPayload = {
  model: "claude-haiku-4.5",
  max_tokens: 64,
  messages: [{ role: "user", content: "Hello" }],
}

describe("createMessages retry behavior", () => {
  beforeEach(() => {
    resetState()
  })

  afterEach(() => {
    restoreGlobals()
  })

  test("retries once on retryable upstream connection resets", async () => {
    const requestIds: Array<string | undefined> = []
    let callCount = 0

    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      callCount += 1
      requestIds.push(getHeaderValue(init, "x-request-id"))

      if (callCount === 1) {
        const error = new Error(
          "The socket connection was closed unexpectedly",
        ) as Error & {
          code?: string
        }
        error.code = "ECONNRESET"
        return Promise.reject(error)
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4.5",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      )
    }) as unknown as typeof fetch

    const response = await createMessages(basePayload)

    expect(callCount).toBe(2)
    expect(requestIds).toHaveLength(2)
    expect(requestIds[0]).toBeDefined()
    expect(requestIds[0]).toBe(requestIds[1])
    expect(response).toMatchObject({
      id: "msg_1",
      model: "claude-haiku-4.5",
    })
  })

  test("throws upstream connection error after retryable connection failures are exhausted", async () => {
    let callCount = 0

    globalThis.fetch = ((_input: unknown, _init?: RequestInit) => {
      callCount += 1
      const error = new Error(
        "The socket connection was closed unexpectedly",
      ) as Error & {
        code?: string
      }
      error.code = "ECONNRESET"
      return Promise.reject(error)
    }) as unknown as typeof fetch

    const error = await getThrownError(() => createMessages(basePayload))

    expect(error).toBeInstanceOf(UpstreamConnectionError)
    expect(callCount).toBe(2)
  })

  test("does not retry non-retryable upstream HTTP errors", async () => {
    let callCount = 0

    globalThis.fetch = ((_input: unknown, _init?: RequestInit) => {
      callCount += 1
      return Promise.resolve(new Response("bad request", { status: 400 }))
    }) as unknown as typeof fetch

    const error = await getThrownError(() => createMessages(basePayload))

    expect(error).toBeInstanceOf(HTTPError)
    expect(callCount).toBe(1)
  })
})

describe("createMessages payload handling", () => {
  beforeEach(() => {
    resetState()
  })

  afterEach(() => {
    restoreGlobals()
  })

  test("logs the full messages payload when upstream returns an HTTP error", async () => {
    const errorLogs: Array<{
      message: unknown
      payload: unknown
    }> = []
    consola.error = ((message: unknown, payload: unknown) => {
      errorLogs.push({ message, payload })
    }) as typeof consola.error

    const payload = {
      ...basePayload,
      stream: true,
      metadata: {
        user_id: "user_123",
      },
      context_management: {
        foo: "bar",
      },
      messages: [
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "Need tool context" },
      ],
    } as AnthropicMessagesPayload & {
      context_management: {
        foo: string
      }
    }

    globalThis.fetch = ((_input: unknown, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message: "context_management: Extra inputs are not permitted",
              type: "invalid_request_error",
            },
            type: "error",
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/json",
              "x-request-id": "req_123",
            },
          },
        ),
      )) as unknown as typeof fetch

    const error = await getThrownError(() => createMessages(payload))

    expect(error).toBeInstanceOf(HTTPError)
    expect(errorLogs).toHaveLength(2)
    expect(errorLogs[0]).toMatchObject({
      message: "Failed to create messages",
      payload: {
        messageCount: 2,
        removedKeys: ["context_management"],
        requestHeaders: {
          Authorization: "Bearer [REDACTED]",
          "X-Initiator": "agent",
          "content-type": "application/json",
        },
        responseHeaders: {
          "content-type": "application/json",
          "x-request-id": "req_123",
        },
      },
    })
    const requestHeaders = (
      errorLogs[0]?.payload as {
        requestHeaders: Record<string, string>
      }
    ).requestHeaders
    expect(typeof requestHeaders["x-request-id"]).toBe("string")
    expect(errorLogs[1]).toEqual({
      message: "Failed to create messages request payload",
      payload: JSON.stringify({
        ...payload,
        context_management: undefined,
      }),
    })
    expect(errorLogs[0]?.payload).toMatchObject({
      messageCount: 2,
    })
  })

  test("removes unsupported context_management before sending native messages upstream", async () => {
    let sentBody: string | undefined

    const payload = {
      ...basePayload,
      context_management: {
        foo: "bar",
      },
    } as AnthropicMessagesPayload & {
      context_management: {
        foo: string
      }
    }

    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      sentBody = typeof init?.body === "string" ? init.body : undefined

      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4.5",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      )
    }) as unknown as typeof fetch

    await createMessages(payload)

    expect(sentBody).toBeDefined()
    expect(JSON.parse(sentBody as string)).not.toHaveProperty(
      "context_management",
    )
  })

  test("logs removed keys before sending native messages upstream", async () => {
    const debugLogs: Array<{
      message: unknown
      payload: unknown
    }> = []
    consola.debug = ((message: unknown, payload: unknown) => {
      debugLogs.push({ message, payload })
    }) as typeof consola.debug

    const payload = {
      ...basePayload,
      context_management: {
        foo: "bar",
      },
    } as AnthropicMessagesPayload & {
      context_management: {
        foo: string
      }
    }

    globalThis.fetch = ((_input: unknown, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4.5",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      )) as unknown as typeof fetch

    await createMessages(payload)

    expect(debugLogs).toHaveLength(1)
    expect(debugLogs[0]).toMatchObject({
      message: "Native messages upstream request:",
      payload: {
        removedKeys: ["context_management"],
      },
    })
  })
})

describe("createMessages cache_control sanitization", () => {
  beforeEach(() => {
    resetState()
  })

  afterEach(() => {
    restoreGlobals()
  })

  test("removes scope from any nested cache_control before sending native messages upstream", async () => {
    let sentBody: string | undefined

    const payload = {
      ...basePayload,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hello with cached block",
              cache_control: {
                scope: "global",
                type: "ephemeral",
              },
            },
          ],
        },
      ],
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.89.27b;",
        },
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
        {
          type: "text",
          text: "cached system block",
          cache_control: {
            scope: "global",
            type: "ephemeral",
          },
        },
      ],
    } as AnthropicMessagesPayload & {
      messages: Array<{
        role: "user"
        content: Array<{
          type: "text"
          text: string
          cache_control?: {
            scope?: string
            type: string
          }
        }>
      }>
      system: Array<{
        type: "text"
        text: string
        cache_control?: {
          scope?: string
          type: string
        }
      }>
    }

    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      sentBody = typeof init?.body === "string" ? init.body : undefined

      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4.5",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      )
    }) as unknown as typeof fetch

    await createMessages(payload)

    expect(sentBody).toBeDefined()
    expect(JSON.parse(sentBody as string)).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hello with cached block",
              cache_control: {
                type: "ephemeral",
              },
            },
          ],
        },
      ],
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.89.27b;",
        },
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
        {
          type: "text",
          text: "cached system block",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
    expect(JSON.parse(sentBody as string)).not.toHaveProperty(
      "messages.0.content.0.cache_control.scope",
    )
    expect(JSON.parse(sentBody as string)).not.toHaveProperty(
      "system.2.cache_control.scope",
    )
  })
})

describe("createMessages streaming retry window", () => {
  beforeEach(() => {
    resetState()
  })

  afterEach(() => {
    restoreGlobals()
  })

  test("does not retry streaming connection resets after the retry window", async () => {
    let callCount = 0
    const timestamps = [0, 1501]
    Date.now = () => timestamps.shift() ?? 1501

    globalThis.fetch = ((_input: unknown, _init?: RequestInit) => {
      callCount += 1
      const error = new Error(
        "The socket connection was closed unexpectedly",
      ) as Error & {
        code?: string
      }
      error.code = "ECONNRESET"
      return Promise.reject(error)
    }) as unknown as typeof fetch

    const error = await getThrownError(() =>
      createMessages({
        ...basePayload,
        stream: true,
      }),
    )

    expect(error).toBeInstanceOf(UpstreamConnectionError)
    expect(callCount).toBe(1)
  })
})

function resetState() {
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.100.0"
}

function restoreGlobals() {
  globalThis.fetch = originalFetch
  Date.now = originalDateNow
  consola.debug = originalConsolaDebug
  consola.error = originalConsolaError
}

async function getThrownError<T>(action: () => Promise<T>): Promise<unknown> {
  try {
    await action()
  } catch (error) {
    return error
  }

  return undefined
}

function getHeaderValue(
  init: RequestInit | undefined,
  headerName: string,
): string | undefined {
  if (!init?.headers) {
    return undefined
  }

  if (init.headers instanceof Headers) {
    return init.headers.get(headerName) ?? undefined
  }

  if (Array.isArray(init.headers)) {
    const matchedHeader = init.headers.find(
      ([name]) => name.toLowerCase() === headerName.toLowerCase(),
    )
    return matchedHeader?.[1]
  }

  const headers = init.headers as Record<string, string>

  return headers[headerName] ?? headers[headerName.toLowerCase()]
}
