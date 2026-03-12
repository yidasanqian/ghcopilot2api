import { expect, test } from "bun:test"

import { resolveInitiator } from "../src/services/copilot/resolve-initiator"

test("sets X-Initiator to agent if tool/assistant present", () => {
  const initiator = resolveInitiator([{ role: "user" }, { role: "tool" }])

  expect(initiator).toBe("agent")
})

test("sets X-Initiator to user if only user present", () => {
  const initiator = resolveInitiator([{ role: "user" }, { role: "user" }])

  expect(initiator).toBe("user")
})
