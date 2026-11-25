import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { HarnessEvent } from "@novadeck/harness-core/events"
import type { Report } from "@novadeck/harness-core/report"
import { hookReport } from "@novadeck/harness-core/testing/reports"
import { describe, expect, it } from "vitest"

import { decode } from "./decode.js"
import { pi } from "./index.js"

type Payload = Report["payload"]

// What Novadeck's extension reported over one session of pi 1.6.0 on Novadeck's fake model
// (2026-11-24): a write, an edit, a failed command, the person's `!` command, an answer stopped
// with Escape, a resume and a compaction.
const reports = readFileSync(join(import.meta.dirname, "fixtures", "reports.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Payload & { hook_event_name: string })

const reportsOf = (event: string): readonly Payload[] =>
  reports.filter((report) => report.hook_event_name === event)
const decoded = (event: string, payload: Payload, seq = 5): readonly HarnessEvent[] =>
  decode(hookReport("pi", event, payload, { seq }))

const session = reportsOf("SessionStart")[0]!.session_id as string
const cwd = "/home/person/project"

describe("pi's reports, as Novadeck's extension made them (probed 2026-11-24, 1.6.0)", () => {
  it("binds a new session at its prompt, with its folder, transcript, version and model", () => {
    const facts = decoded("SessionStart", reportsOf("SessionStart")[0]!)
    expect(facts).toEqual([
      expect.objectContaining({
        type: "session-observed",
        agent: "pi",
        sessionId: session,
        evidence: "startup",
        atPrompt: true,
        cwd,
        transcript: expect.stringMatching(new RegExp(`_${session}\\.jsonl$`)),
      }),
      expect.objectContaining({ type: "telemetry-observed", version: "1.6.0" }),
      expect.objectContaining({ type: "telemetry-observed", model: "fake/fake-1", effort: "low" }),
    ])
  })

  it("binds a resumed session as a switch, and a compaction as the same session compacted", () => {
    const [, resumed] = reportsOf("SessionStart")
    expect(decoded("SessionStart", resumed!)[0]).toMatchObject({
      evidence: "native-switch",
      atPrompt: true,
    })
    const compacted = reportsOf("SessionStart").find((payload) => payload.source === "compact")!
    const [fact] = decoded("SessionStart", compacted)
    expect(fact).toMatchObject({ type: "session-observed", compacted: true, sessionId: session })
    expect(fact).not.toHaveProperty("atPrompt")
  })

  it("starts a turn with each of the person's prompts, with the model it runs on", () => {
    const starts = reportsOf("UserPromptSubmit").map((payload) =>
      decoded("UserPromptSubmit", payload),
    )
    expect(starts.map(([start]) => start?.type === "turn-started" && start.prompt)).toEqual([
      "WRITETOOL now",
      "EDITTOOL now",
      "FAILTOOL now",
      "hello there",
      "SLOW stop me",
      "after compact",
      "after real compact",
      "after real compact",
    ])
    expect(starts[0]![1]).toMatchObject({ type: "telemetry-observed", model: "fake/fake-1" })
  })

  it("ends a turn completed with its reply and how full the context is", () => {
    const [first] = reportsOf("Stop")
    expect(decoded("Stop", first!)).toEqual([
      expect.objectContaining({
        type: "turn-ended",
        outcome: "completed",
        reply: "done after tool",
      }),
      expect.objectContaining({
        type: "telemetry-observed",
        context: { occupied: expect.any(Number), capacity: 128000 },
        model: "fake/fake-1",
      }),
    ])
  })

  it("ends a turn stopped with Escape as interrupted", () => {
    const stopped = reportsOf("Stop").find(
      (payload) => (payload.error as { name?: string } | null)?.name === "aborted",
    )!
    expect(decoded("Stop", stopped)[0]).toMatchObject({
      type: "turn-ended",
      outcome: "interrupted",
    })
  })

  it("ends a failed turn with its error, and a quota's as a usage limit", () => {
    const failed = (message: string) =>
      decoded("Stop", { session_id: session, error: { name: "error", message } })[0]
    expect(failed("500: server exploded")).toMatchObject({
      outcome: "failed",
      error: "500: server exploded",
    })
    expect(failed("500: server exploded")).not.toHaveProperty("limited")
    expect(failed('429: {"message":"You exceeded your current quota"}')).toMatchObject({
      outcome: "failed",
      limited: true,
    })
  })

  it("settles a root call where a lead's message is delivered, and tells the file it wrote", () => {
    const [write] = reportsOf("PostToolUse")
    expect(decoded("PostToolUse", write!)).toEqual([
      expect.objectContaining({
        type: "attention-resolved",
        toolName: "write",
        outcome: "allowed",
      }),
      expect.objectContaining({ type: "file-touched", path: `${cwd}/notes.txt` }),
      expect.objectContaining({ type: "tool-called", toolName: "write", kind: "work" }),
    ])
  })

  it("tells a codemode script's own calls as work, never as a place to deliver", () => {
    const facts = decoded("NestedToolUse", {
      session_id: session,
      cwd,
      tool_name: "bash",
      call_id: "call_3/1",
      parent_call_id: "call_3",
      tool_input: { command: "cd sub && make" },
    })
    expect(facts.map((fact) => fact.type)).toEqual(["tool-called"])
    expect(facts[0]).toMatchObject({ folder: `${cwd}/sub` })
  })

  it("counts Novadeck's own tools as Novadeck's", () => {
    const facts = decoded("PostToolUse", {
      session_id: session,
      tool_name: "novadeck_send",
      tool_input: { to: "@fox", text: "hi" },
    })
    expect(facts.at(-1)).toMatchObject({ type: "tool-called", kind: "novadeck" })
  })

  it("asks the person through an extension's dialog, settled once it goes", () => {
    const shown = decoded("DialogShown", {
      session_id: session,
      request_id: "ui-1",
      kind: "confirm",
      title: "Allow rm -rf build?",
    })
    expect(shown).toEqual([
      expect.objectContaining({
        type: "attention-requested",
        requestId: "ui-1",
        kind: "permission",
        toolName: "confirm",
        subject: "Allow rm -rf build?",
        input: { title: "Allow rm -rf build?" },
      }),
    ])
    expect(
      decoded("DialogShown", {
        session_id: session,
        request_id: "ui-2",
        kind: "select",
        title: "Pick",
      })[0],
    ).toMatchObject({ kind: "question", toolName: "select" })
    expect(
      decoded("DialogEnded", { session_id: session, request_id: "ui-1", kind: "confirm" }),
    ).toEqual([
      expect.objectContaining({
        type: "attention-resolved",
        requestId: "ui-1",
        outcome: "settled",
      }),
    ])
  })

  it("reads nothing from a report without a session, nor from one it doesn't know", () => {
    expect(decoded("Stop", { error: null })).toEqual([])
    expect(decoded("Something", { session_id: session })).toEqual([])
  })
})

// pi names its process `pi`, so the relay reads it as started with no words (Linux, 1.6.0): the
// flags a resume gives back come from what the extension sends.
describe("the words pi was started with", () => {
  const start = reportsOf("SessionStart")[0]!
  const launchOf = (payload: Payload, launch?: readonly string[]) =>
    pi
      .decode(hookReport("pi", "SessionStart", payload, launch ? { launch } : {}))
      .find((fact) => fact.type === "session-observed")
  const words = ["-e", "/data/novadeck.js", "--no-tools", "--thinking", "high"]

  it("are what the extension sent, over the none the relay read", () => {
    expect(launchOf({ ...start, argv: words }, [])).toMatchObject({
      launch: ["--no-tools", "--thinking", "high"],
    })
  })

  it("are what the relay read where the extension sent none, or more than it would take", () => {
    expect(launchOf(start, ["--no-mcp"])).toMatchObject({ launch: ["--no-mcp"] })
    const many = { ...start, argv: Array.from({ length: 129 }, () => "--no-tools") }
    expect(launchOf(many, ["--no-mcp"])).toMatchObject({ launch: ["--no-mcp"] })
  })
})
