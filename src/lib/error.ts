import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import { getResponseLogDetails } from "~/lib/upstream-log"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export class RequestValidationError extends Error {
  status: ContentfulStatusCode

  constructor(message: string, status: ContentfulStatusCode = 400) {
    super(message)
    this.status = status
  }
}

export class UpstreamConnectionError extends Error {
  status: ContentfulStatusCode

  constructor(
    message: string,
    options: {
      cause?: unknown
      status?: ContentfulStatusCode
    } = {},
  ) {
    super(message, { cause: options.cause })
    this.status = options.status ?? 502
  }
}

export async function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    const responseLogDetails = await getResponseLogDetails(error.response)
    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", {
      ...responseLogDetails,
      body: errorJson,
    })
    return c.json(
      {
        error: {
          message: errorText,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  if (error instanceof RequestValidationError) {
    return c.json(
      {
        error: {
          message: error.message,
          type: "invalid_request_error",
        },
      },
      error.status,
    )
  }

  if (error instanceof UpstreamConnectionError) {
    return c.json(
      {
        error: {
          message: error.message,
          type: "error",
        },
      },
      error.status,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}
