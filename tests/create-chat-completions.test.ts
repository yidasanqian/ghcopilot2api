import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { HTTPError, UpstreamConnectionError } from "~/lib/error"
import { state } from "~/lib/state"
import { resolveInitiator } from "~/services/copilot/resolve-initiator"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

mock.restore()

const { createChatCompletions } = await import(
  "../src/services/copilot/create-chat-completions"
)

const originalFetch = globalThis.fetch

const basePayload: ChatCompletionsPayload = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
}

describe("resolveInitiator", () => {
  test("sets X-Initiator to agent if tool/assistant present", () => {
    const initiator = resolveInitiator([{ role: "user" }, { role: "tool" }])

    expect(initiator).toBe("agent")
  })

  test("sets X-Initiator to user if only user present", () => {
    const initiator = resolveInitiator([{ role: "user" }, { role: "user" }])

    expect(initiator).toBe("user")
  })
})

describe("createChatCompletions", () => {
  beforeEach(() => {
    state.accountType = "individual"
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.100.0"
    state.models = undefined
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
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
            id: "chatcmpl_1",
            object: "chat.completion",
            created: 1,
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "ok",
                },
                logprobs: null,
                finish_reason: "stop",
              },
            ],
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

    const response = await createChatCompletions(basePayload)

    expect(callCount).toBe(2)
    expect(requestIds).toHaveLength(2)
    expect(requestIds[0]).toBeDefined()
    expect(requestIds[0]).toBe(requestIds[1])
    expect(response).toMatchObject({
      id: "chatcmpl_1",
      model: "gpt-4o",
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

    const error = await getThrownError(() => createChatCompletions(basePayload))

    expect(error).toBeInstanceOf(UpstreamConnectionError)
    expect(callCount).toBe(2)
  })

  test("does not retry non-retryable upstream HTTP errors", async () => {
    let callCount = 0

    globalThis.fetch = ((_input: unknown, _init?: RequestInit) => {
      callCount += 1
      return Promise.resolve(new Response("bad request", { status: 400 }))
    }) as unknown as typeof fetch

    const error = await getThrownError(() => createChatCompletions(basePayload))

    expect(error).toBeInstanceOf(HTTPError)
    expect(callCount).toBe(1)
  })
})

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
