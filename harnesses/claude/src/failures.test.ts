import type { Report } from "@novadeck/harness-core/report"
import { describe, expect, it } from "vitest"

import { decode } from "./decode.js"

const stopFailure = (payload: Report["payload"]) =>
  decode({
    terminalId: "t",
    token: "0".repeat(48),
    agent: "claude",
    event: "StopFailure",
    seq: 1,
    instance: "7",
    env: { cursor: false },
    payload: { session_id: "s", ...payload },
  })

// Payloads as Claude Code 2.1.287 sent them (probed 2026-10-15).
describe("Claude Code's StopFailure", () => {
  it("fails the turn with the message it showed, and says a usage limit when it was one", () => {
    expect(
      stopFailure({
        error: "rate_limit",
        last_assistant_message:
          "API Error: Request rejected (429) · This request would exceed your usage limit.",
      }),
    ).toMatchObject([
      {
        type: "turn-ended",
        outcome: "failed",
        error: "API Error: Request rejected (429) · This request would exceed your usage limit.",
        limited: true,
      },
    ])
  })

  it("is no limit for any other error, and reads an unclassed one by its message", () => {
    const [event] = stopFailure({
      error: "unknown",
      last_assistant_message: "API Error: 400 The fake model refused the request.",
    })
    expect(event).toMatchObject({
      outcome: "failed",
      error: "API Error: 400 The fake model refused the request.",
    })
    expect(event).not.toHaveProperty("limited")
  })

  it("falls back to error_details, then to a named class, never to unknown", () => {
    expect(stopFailure({ error: "overloaded", error_details: "529 Overloaded" })).toMatchObject([
      { error: "529 Overloaded" },
    ])
    expect(stopFailure({ error: "billing_error" })).toMatchObject([{ error: "billing_error" }])
    expect(stopFailure({ error: "unknown" })[0]).not.toHaveProperty("error")
  })

  it("keeps escapes and control characters out of the text", () => {
    expect(
      stopFailure({
        error: "unknown",
        last_assistant_message: "\u001b[31mAPI Error\u001b[0m\u0007: 500",
      })[0],
    ).toMatchObject({ error: "API Error : 500" })
  })

  it("names no error on a subagent's failure, which ends no turn", () => {
    expect(stopFailure({ error: "rate_limit", agent_id: "a" })).toEqual([])
  })
})

describe("Claude Code's written files", () => {
  const tool = (event: string) =>
    decode({
      terminalId: "t",
      token: "0".repeat(48),
      agent: "claude",
      event,
      seq: 1,
      instance: "7",
      env: { cursor: false },
      payload: { session_id: "s", tool_name: "Edit", tool_input: { file_path: "/w/a.ts" } },
    }).filter(({ type }) => type === "file-touched")

  it("name a file once its tool succeeded, never when it failed", () => {
    expect(tool("PostToolUse")).toMatchObject([{ path: "/w/a.ts" }])
    expect(tool("PostToolUseFailure")).toEqual([])
  })
})
