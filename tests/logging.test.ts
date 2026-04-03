import { describe, expect, test } from "bun:test"

import {
  DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS,
  LOG_TIME_ZONE,
  formatRequestDuration,
  getRequestUrlForLog,
  prependLogTimestamp,
} from "~/lib/logging"

describe("logging helpers", () => {
  test("prepends GMT+8 timestamp to log lines", () => {
    const message = prependLogTimestamp(
      "<-- POST /v1/messages?beta=true",
      new Date("2026-03-13T12:34:56.789Z"),
    )

    expect(message).toBe(
      "[2026-03-13T20:34:56.789+08:00] <-- POST /v1/messages?beta=true",
    )
  })

  test("keeps full request url in logs", () => {
    expect(
      getRequestUrlForLog("http://localhost:4141/v1/messages?beta=true"),
    ).toBe("http://localhost:4141/v1/messages?beta=true")
  })

  test("formats request duration for logs", () => {
    expect(formatRequestDuration(128)).toBe("128ms")
    expect(formatRequestDuration(6100)).toBe("6s")
  })

  test("sets runtime timezone to Asia/Shanghai", () => {
    expect(process.env.TZ).toBe(LOG_TIME_ZONE)
  })

  test("uses a higher default HTTP idle timeout", () => {
    expect(DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS).toBe(120)
  })
})
