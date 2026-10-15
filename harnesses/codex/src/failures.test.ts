import type { Report } from "@novadeck/harness-core/report"
import { describe, expect, it } from "vitest"

import { decode } from "./decode.js"
import { rolloutEvents } from "./rollout.js"

const run = { sessionId: "s", instance: "7" }
const complete = (fields: object) =>
  rolloutEvents(
    JSON.stringify({
      timestamp: "2026-10-15T06:18:46.764Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "t1", last_agent_message: null, ...fields },
    }),
    run,
  )

// Records as Codex wrote them (a usage-limit turn of 2026-10-15, codex 0.16x).
describe("Codex's task_complete with an error", () => {
  it("fails the turn with its message, and says a usage limit by codex_error_info", () => {
    expect(
      complete({
        error: {
          message: "You’ve hit your usage limit. Try again at 2:41 AM.",
          codex_error_info: "usage_limit_exceeded",
        },
      }),
    ).toMatchObject([
      {
        type: "turn-ended",
        outcome: "failed",
        recorded: true,
        error: "You’ve hit your usage limit. Try again at 2:41 AM.",
        limited: true,
      },
    ])
  })

  it("is no limit for another error", () => {
    const [event] = complete({
      error: { message: "stream disconnected", codex_error_info: "other" },
    })
    expect(event).toMatchObject({ outcome: "failed", error: "stream disconnected" })
    expect(event).not.toHaveProperty("limited")
  })

  it("fails the turn even where the error gives no message", () => {
    const [event] = complete({ error: { codex_error_info: { http_connection_failed: {} } } })
    expect(event).toMatchObject({ outcome: "failed" })
    expect(event).not.toHaveProperty("error")
  })

  it("names no error for a completed turn", () => {
    const [event] = complete({ last_agent_message: "Done." })
    expect(event).toMatchObject({ outcome: "completed" })
    expect(event).not.toHaveProperty("error")
  })
})

describe("Codex's FileChange item", () => {
  const changed = (item: object) =>
    rolloutEvents(
      JSON.stringify({
        timestamp: "2026-10-15T06:18:46.764Z",
        type: "event_msg",
        payload: { type: "item_completed", turn_id: "t1", item: { type: "FileChange", ...item } },
      }),
      run,
    )

  it("names each file a patch changed, whether it ran as a tool or through the shell", () => {
    expect(
      changed({
        status: "completed",
        changes: { "/w/a.ts": { type: "add", content: "x\n" }, "/w/b.ts": { type: "update" } },
      }),
    ).toMatchObject([
      { type: "file-touched", path: "/w/a.ts", actor: null },
      { type: "file-touched", path: "/w/b.ts" },
    ])
  })

  it("names none for a patch that failed, or a relative path", () => {
    expect(changed({ status: "failed", changes: { "/w/a.ts": {} } })).toEqual([])
    expect(changed({ status: "completed", changes: { "a.ts": {} } })).toEqual([])
  })
})

describe("Codex's apply_patch PostToolUse", () => {
  const patch = "*** Begin Patch\n*** Add File: /w/a.ts\n+x\n*** End Patch"
  const touched = (response: unknown) =>
    decode({
      terminalId: "t",
      token: "0".repeat(48),
      agent: "codex",
      event: "PostToolUse",
      seq: 1,
      instance: "7",
      env: { cursor: false },
      payload: {
        session_id: "s",
        tool_name: "apply_patch",
        tool_input: { command: patch },
        tool_response: response,
      } as Report["payload"],
    }).filter(({ type }) => type === "file-touched")

  it("names the files of a patch that applied", () => {
    expect(touched("Success. Updated the following files:\nA /w/a.ts\n")).toMatchObject([
      { path: "/w/a.ts" },
    ])
    expect(touched(undefined)).toMatchObject([{ path: "/w/a.ts" }])
  })

  it("names none for a patch whose response says it did not", () => {
    expect(touched("apply_patch verification failed: Failed to find expected lines")).toEqual([])
  })
})
