import { describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { getResponseLogDetails, getUpstreamErrorLog } from "~/lib/upstream-log"

describe("upstream log helpers", () => {
  test("reads response headers and json body for logs", async () => {
    const response = new Response(
      JSON.stringify({ error: { message: "upstream unavailable" } }),
      {
        status: 502,
        statusText: "Bad Gateway",
        headers: {
          "content-type": "application/json",
          "x-request-id": "resp_123",
        },
      },
    )

    const details = await getResponseLogDetails(response)

    expect(details).toMatchObject({
      status: 502,
      statusText: "Bad Gateway",
      headers: {
        "content-type": "application/json",
        "x-request-id": "resp_123",
      },
      body: {
        error: {
          message: "upstream unavailable",
        },
      },
    })
  })

  test("extracts nested response details from error causes", async () => {
    const upstreamResponse = new Response("gateway reset", {
      status: 502,
      statusText: "Bad Gateway",
      headers: {
        "content-type": "text/plain;charset=UTF-8",
        "x-github-request-id": "gh_123",
      },
    })

    const error = new Error("socket closed", {
      cause: new HTTPError("Failed to create messages", upstreamResponse),
    }) as Error & {
      code?: string
    }
    error.code = "ECONNRESET"

    const log = await getUpstreamErrorLog(error)

    expect(log).toMatchObject({
      name: "Error",
      message: "socket closed",
      code: "ECONNRESET",
      response: {
        status: 502,
        statusText: "Bad Gateway",
        headers: {
          "content-type": "text/plain;charset=UTF-8",
          "x-github-request-id": "gh_123",
        },
        body: "gateway reset",
      },
    })
  })
})
