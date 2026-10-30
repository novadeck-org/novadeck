import type { Report } from "@novadeck/harness-core/report"
import { describe, expect, it } from "vitest"

import { hook } from "./report.test-support.js"

const ended = (payload: Report["payload"]) =>
  hook("Stop", { fullyIdle: true, ...payload }).find(({ type }) => type === "turn-ended")

// Errors as Antigravity 1.2.14 put them in Stop (probed 2026-10-15, against a fake model).
describe("Antigravity's Stop with an error", () => {
  it("fails the turn with its text", () => {
    const event = ended({
      terminationReason: "ERROR",
      error: "generating and executing: Error 400, Message: Bad request, Status: , Details: []",
    })
    expect(event).toMatchObject({
      outcome: "failed",
      error: "generating and executing: Error 400, Message: Bad request, Status: , Details: []",
    })
    expect(event).not.toHaveProperty("limited")
  })

  it("says a usage limit when the API's status is RESOURCE_EXHAUSTED", () => {
    expect(
      ended({
        terminationReason: "ERROR",
        error:
          "generating and executing: Error 429, Message: You have exhausted your capacity on this model. Your quota will reset after 59m30s., Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo reason:QUOTA_EXHAUSTED]]",
      }),
    ).toMatchObject({ outcome: "failed", limited: true })
  })

  it("takes a mere rate limit for no usage limit", () => {
    expect(
      ended({
        terminationReason: "ERROR",
        error:
          "generating and executing: Error 429, Message: Too many requests, Status: RESOURCE_EXHAUSTED, Details: [map[reason:RATE_LIMIT_EXCEEDED]]",
      }),
    ).not.toHaveProperty("limited")
  })

  it("reads the reason from the whole error, however long", () => {
    const long = `generating and executing: Error 429, Message: ${"x".repeat(3000)}, Status: RESOURCE_EXHAUSTED, Details: [map[reason:RATE_LIMIT_EXCEEDED]]`
    const event = ended({ terminationReason: "ERROR", error: long })
    expect(event).toMatchObject({ outcome: "failed" })
    expect(event).not.toHaveProperty("limited")
    const spent = ended({
      terminationReason: "ERROR",
      error: `Error 429, Message: ${"x".repeat(3000)}, Status: RESOURCE_EXHAUSTED`,
    })
    expect(spent).toMatchObject({ limited: true })
  })

  it("names no error for a completed turn", () => {
    const event = ended({ error: "", terminationReason: "NO_TOOL_CALL" })
    expect(event).toMatchObject({ outcome: "completed" })
    expect(event).not.toHaveProperty("error")
  })
})

describe("Antigravity's edit tools", () => {
  const touched = (name: string, extra: Record<string, unknown> = {}) =>
    hook("PostToolUse", { toolCall: { name, args: { TargetFile: "/w/a.ts" } }, ...extra }).filter(
      ({ type }) => type === "file-touched",
    )

  it("name the file they wrote, replace_file_content as write_to_file", () => {
    expect(touched("replace_file_content")).toMatchObject([{ path: "/w/a.ts", actor: null }])
    expect(touched("write_to_file")).toMatchObject([{ path: "/w/a.ts" }])
  })

  it("name the file 1.4's write_file and edit_file wrote, as Path", () => {
    const named = (name: string) =>
      hook("PostToolUse", { toolCall: { name, args: { Path: "/w/b.ts" } } }).filter(
        ({ type }) => type === "file-touched",
      )
    expect(named("write_file")).toMatchObject([{ path: "/w/b.ts", actor: null }])
    expect(named("edit_file")).toMatchObject([{ path: "/w/b.ts" }])
    expect(named("read_file")).toEqual([])
  })

  it("name none for a read, a relative path or a call that failed", () => {
    expect(touched("view_file")).toEqual([])
    expect(
      hook("PostToolUse", {
        toolCall: { name: "replace_file_content", args: { TargetFile: "a.ts" } },
      }).filter(({ type }) => type === "file-touched"),
    ).toEqual([])
    expect(touched("replace_file_content", { error: "no match" })).toEqual([])
  })
})
