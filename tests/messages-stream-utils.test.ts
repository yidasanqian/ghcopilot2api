import { describe, expect, test } from "bun:test"

import { isStreamDoneSentinel } from "~/routes/messages/utils"

describe("messages stream utils", () => {
  test("detects OpenAI-style DONE sentinels without treating JSON events as done", () => {
    expect(isStreamDoneSentinel("[DONE]")).toBe(true)
    expect(isStreamDoneSentinel('{"type":"message_stop"}')).toBe(false)
    expect(isStreamDoneSentinel(undefined)).toBe(false)
  })
})
