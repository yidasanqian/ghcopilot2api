import consola from "consola"

import { UpstreamConnectionError } from "~/lib/error"
import {
  getResponseBodyForLog,
  getResponseHeadersForLog,
  getUpstreamErrorLog,
} from "~/lib/upstream-log"

const DEFAULT_MAX_ATTEMPTS = 2
const RETRYABLE_UPSTREAM_STATUS_CODES = new Set([502, 503, 504])
const RETRYABLE_UPSTREAM_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
])
const RETRYABLE_UPSTREAM_ERROR_PATTERNS = [
  /socket connection was closed unexpectedly/i,
  /connect timeout/i,
  /timed out/i,
]

interface FetchWithUpstreamRetryOptions {
  exhaustedMessage: string
  init: RequestInit
  operationName: string
  requestId?: string
  requestMetadata?: Record<string, unknown>
  url: string
  maxAttempts?: number
}

export async function fetchWithUpstreamRetry(
  options: FetchWithUpstreamRetryOptions,
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  let lastRetryableError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(options.url, options.init)

      if (
        response.ok
        || !shouldRetryUpstreamResponse(response)
        || attempt === maxAttempts
      ) {
        return response
      }

      const errorBody = await getResponseBodyForLog(response)
      consola.warn(
        `Retrying ${options.operationName} request after transient upstream response`,
        {
          attempt,
          maxAttempts,
          status: response.status,
          statusText: response.statusText,
          requestId: options.requestId,
          responseRequestId:
            response.headers.get("x-request-id")
            ?? response.headers.get("x-github-request-id"),
          ...options.requestMetadata,
          responseHeaders: getResponseHeadersForLog(response),
          body: errorBody,
        },
      )
    } catch (error) {
      if (!shouldRetryUpstreamError(error)) {
        throw error
      }

      lastRetryableError = error

      if (attempt === maxAttempts) {
        break
      }

      consola.warn(
        `Retrying ${options.operationName} request after transient upstream connection error`,
        {
          attempt,
          maxAttempts,
          requestId: options.requestId,
          ...options.requestMetadata,
          error: await getUpstreamErrorLog(error),
        },
      )
    }

    await sleep(getRetryDelayMs(attempt))
  }

  consola.error(
    `Failed to create ${options.operationName} after transient upstream retries`,
    {
      requestId: options.requestId,
      ...options.requestMetadata,
      error: await getUpstreamErrorLog(lastRetryableError),
    },
  )

  throw new UpstreamConnectionError(options.exhaustedMessage, {
    cause: lastRetryableError,
  })
}

function shouldRetryUpstreamResponse(response: Response): boolean {
  return RETRYABLE_UPSTREAM_STATUS_CODES.has(response.status)
}

function shouldRetryUpstreamError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const errorCode = getErrorCode(error)

  if (errorCode && RETRYABLE_UPSTREAM_ERROR_CODES.has(errorCode)) {
    return true
  }

  return RETRYABLE_UPSTREAM_ERROR_PATTERNS.some((pattern) =>
    pattern.test(error.message),
  )
}

function getErrorCode(error: Error): string | undefined {
  const code = (error as Error & { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

function getRetryDelayMs(attempt: number): number {
  return 200 * attempt
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
