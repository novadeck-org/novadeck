import { describe, expect, it } from "vitest"

import { approval } from "./terminals.js"

describe("approval", () => {
  const request = (action: unknown) => ({
    type: "request",
    requestId: "11111111-1111-4111-8111-111111111111",
    from: "22222222-2222-4222-8222-222222222222",
    terminalId: "33333333-3333-4333-8333-333333333333",
    sessionId: "44444444-4444-4444-8444-444444444444",
    action,
  })

  it("carries a take of a worktree with its path and branch", () => {
    const action = { type: "take", path: "/w/p/g/api", branch: "feat/x" }
    expect(approval.parse(request(action))).toEqual(request(action))
  })

  it("refuses a take without a branch or with more than it names", () => {
    expect(approval.safeParse(request({ type: "take", path: "/w" })).success).toBe(false)
    expect(
      approval.safeParse(request({ type: "take", path: "/w", branch: "b", force: true })).success,
    ).toBe(false)
  })
})
