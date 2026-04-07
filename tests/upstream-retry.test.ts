import { afterEach, describe, expect, mock, test } from "bun:test"
import consola from "consola"

import { fetchWithUpstreamRetry } from "~/lib/upstream-retry"

const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout
const originalWarn = consola.warn
const originalInfo = consola.info
const originalDateNow = Date.now

describe("fetchWithUpstreamRetry", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    consola.warn = originalWarn
    consola.info = originalInfo
    Date.now = originalDateNow
    mock.restore()
  })

  test("uses exponential backoff delays for retries", async () => {
    const delays: Array<number> = []
    globalThis.setTimeout = ((
      handler: Parameters<typeof setTimeout>[0],
      timeout?: number,
    ) => {
      delays.push(timeout ?? 0)

      if (typeof handler === "function") {
        const callback = handler as () => void
        callback()
      }

      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout

    let callCount = 0
    globalThis.fetch = ((_input: unknown, _init?: RequestInit) => {
      callCount += 1

      if (callCount <= 3) {
        return Promise.resolve(
          new Response("upstream unavailable", {
            status: 503,
            statusText: "Service Unavailable",
          }),
        )
      }

      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch

    const warnCalls: Array<Array<unknown>> = []
    consola.warn = ((...args: Array<unknown>) => {
      warnCalls.push(args)
      return undefined
    }) as typeof consola.warn

    const response = await fetchWithUpstreamRetry({
      exhaustedMessage: "Failed to reach upstream",
      init: { method: "POST" },
      operationName: "messages",
      url: "https://example.com/v1/messages",
      maxAttempts: 4,
    })

    expect(response.status).toBe(200)
    expect(warnCalls).toHaveLength(3)
    expect(delays).toEqual([200, 400, 800])
  })

  test("adds responseTimeMs to retry warning logs", async () => {
    let callCount = 0
    globalThis.fetch = ((_input: unknown, _init?: RequestInit) => {
      callCount += 1

      if (callCount === 1) {
        return Promise.resolve(
          new Response("temporary failure", {
            status: 503,
            statusText: "Service Unavailable",
          }),
        )
      }

      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch

    const warnCalls: Array<Array<unknown>> = []
    consola.warn = ((...args: Array<unknown>) => {
      warnCalls.push(args)
      return undefined
    }) as typeof consola.warn

    await fetchWithUpstreamRetry({
      exhaustedMessage: "Failed to reach upstream",
      init: { method: "POST" },
      operationName: "messages",
      requestId: "req_123",
      url: "https://example.com/v1/messages",
      maxAttempts: 2,
    })

    expect(warnCalls).toHaveLength(1)
    const firstWarnPayload = warnCalls[0]?.[1] as
      | { responseTimeMs?: unknown }
      | undefined

    expect(typeof firstWarnPayload?.responseTimeMs).toBe("number")
  })

  test("logs responseTimeMs when upstream request succeeds without retry", async () => {
    globalThis.fetch = ((_input: unknown, _init?: RequestInit) => {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch

    const infoCalls: Array<Array<unknown>> = []
    consola.info = ((...args: Array<unknown>) => {
      infoCalls.push(args)
      return undefined
    }) as typeof consola.info

    await fetchWithUpstreamRetry({
      exhaustedMessage: "Failed to reach upstream",
      init: { method: "POST" },
      operationName: "messages",
      requestId: "req_success_123",
      url: "https://example.com/v1/messages",
      maxAttempts: 2,
    })

    expect(infoCalls.length).toBeGreaterThan(0)
    const payload = infoCalls[0]?.[1] as
      | { responseTimeMs?: unknown; status?: unknown }
      | undefined
    expect(typeof payload?.responseTimeMs).toBe("number")
    expect(payload?.status).toBe(200)
  })

  test("does not retry connection errors after the retry window", async () => {
    const timestamps = [0, 1501]
    Date.now = () => timestamps.shift() ?? 1501

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

    let thrownError: unknown
    try {
      await fetchWithUpstreamRetry({
        exhaustedMessage: "Failed to reach upstream",
        init: { method: "POST" },
        operationName: "messages",
        requestId: "req_retry_window_123",
        retryConnectionErrorWindowMs: 1000,
        url: "https://example.com/v1/messages",
        maxAttempts: 2,
      })
    } catch (error) {
      thrownError = error
    }

    expect(thrownError).toBeDefined()
    expect(callCount).toBe(1)
  })
})
