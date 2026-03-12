import { expect, test } from "bun:test"

import { resolveInitiator } from "../src/services/copilot/resolve-initiator"

test("sets X-Initiator to agent if tool/assistant present", () => {
  const initiator = resolveInitiator([
    { role: "user", content: "hi" },
    { role: "tool", content: "tool call" },
  ])

  expect(initiator).toBe("agent")
})

test("sets X-Initiator to user if only user present", () => {
  const initiator = resolveInitiator([
    { role: "user", content: "hi" },
    { role: "user", content: "hello again" },
  ])

  expect(initiator).toBe("user")
})
