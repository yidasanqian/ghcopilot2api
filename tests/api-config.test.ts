import { describe, expect, test } from "bun:test"

import { copilotHeaders, githubHeaders } from "~/lib/api-config"

describe("api config headers", () => {
  test("builds copilot headers", () => {
    const headers = copilotHeaders(
      {
        accountType: "individual",
        anthropicUseMessagesApi: true,
        copilotToken: "test-copilot-token",
        githubToken: "test-github-token",
        manualApprove: false,
        rateLimitWait: false,
        showToken: false,
        vsCodeVersion: "1.100.0",
      },
      true,
    )

    expect(headers["x-github-api-version"]).toBe("2025-05-01")
    expect(headers["x-request-id"]).toBeDefined()
    expect(headers["copilot-vision-request"]).toBe("true")
  })

  test("builds github headers with separate github api version", () => {
    const headers = githubHeaders({
      accountType: "individual",
      anthropicUseMessagesApi: true,
      copilotToken: "test-copilot-token",
      githubToken: "test-github-token",
      manualApprove: false,
      rateLimitWait: false,
      showToken: false,
      vsCodeVersion: "1.100.0",
    })

    expect(headers["x-github-api-version"]).toBe("2025-04-01")
    expect(headers["x-vscode-user-agent-library-version"]).toBe(
      "electron-fetch",
    )
  })
})
