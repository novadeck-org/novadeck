import type { Report } from "../../shell/reports.js"
import { describe, expect, it } from "../../test.js"
import { loadProbe } from "../../testing/probes.js"
import { callId } from "../harness.js"
import { decode } from "./decode.js"
import { transcriptEvents, type Calls } from "./transcript.js"

type Probe = { scenarios: { [name: string]: object[] } }
const probe = loadProbe(import.meta.dirname, "transcript.probe.json") as Probe
const session = { sessionId: "s", instance: "7" }
const all = (name: string) =>
  probe.scenarios[name]!.flatMap((record) => transcriptEvents(JSON.stringify(record), session))
const events = (name: string) => all(name).filter(({ type }) => type !== "telemetry-observed")

describe("Claude Code's transcript, as captured", () => {
  it("ends the turn when the person pressed Esc while a tool ran", () => {
    expect(events("interrupt")).toEqual([
      {
        type: "turn-ended",
        agent: "claude",
        sessionId: "s",
        instance: "7",
        startedAt: expect.any(Number),
        outcome: "interrupted",
      },
    ])
  })

  it("ends the turn when the person denied a permission request", () => {
    expect(events("deny")).toMatchObject([{ type: "turn-ended", outcome: "interrupted" }])
  })

  it("dates the end by the record, on the same clock as the hooks", () => {
    const [ended] = events("deny")
    const record = probe.scenarios.deny!.find((each) =>
      JSON.stringify(each).includes("[Request interrupted"),
    ) as { timestamp: string }
    expect(ended?.startedAt).toBe(Date.parse(record.timestamp))
  })
})

describe("Claude Code's context, as its transcript records it", () => {
  it("counts the latest request's input, cache writes and cache reads", () => {
    type Usage = {
      input_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
    }
    const last = probe.scenarios.deny!.findLast(
      (record) => (record as { message?: { usage?: unknown } }).message?.usage,
    ) as { message: { usage: Usage } }
    const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens } =
      last.message.usage
    expect(all("deny").findLast(({ type }) => type === "telemetry-observed")).toMatchObject({
      context: {
        occupied: input_tokens + cache_creation_input_tokens + cache_read_input_tokens,
        capacity: null,
      },
    })
  })
})

describe("a transcript line", () => {
  const line = (record: object) => transcriptEvents(JSON.stringify(record), session)
  const interrupt = {
    type: "user",
    timestamp: "2026-09-30T00:00:00.000Z",
    message: { role: "user", content: "[Request interrupted by user]" },
  }

  it("reads an interruption given as plain text too", () => {
    expect(line(interrupt)).toHaveLength(1)
  })

  it("ignores a subagent's records, malformed lines, and anything else", () => {
    expect(line({ ...interrupt, isSidechain: true })).toEqual([])
    expect(transcriptEvents("not json", session)).toEqual([])
    expect(line({ ...interrupt, timestamp: "whenever" })).toEqual([])
    expect(line({ ...interrupt, message: { role: "user", content: "keep going" } })).toEqual([])
    // A prompt that merely starts like the record.
    const typed = "[Request interrupted by user] was what it said last time"
    expect(line({ ...interrupt, message: { role: "user", content: typed } })).toEqual([])
  })
})

describe("a transcript's record of the turn's Stop hooks", () => {
  // As Claude Code 2.1.289 writes it once a root turn's Stop hooks ran, failing or not.
  const summary = {
    parentUuid: "dd97cd0c-ea4f-4d9e-82eb-71a9ad1679bc",
    isSidechain: false,
    type: "system",
    subtype: "stop_hook_summary",
    hookCount: 1,
    hookInfos: [{ command: '"$NOVADECK_HOOK" claude Stop', durationMs: 9 }],
    hookErrors: ["Failed to run: Plugin directory does not exist"],
    hookAdditionalContext: [],
    preventedContinuation: false,
    stopReason: "",
    hasOutput: true,
    level: "suggestion",
    timestamp: "2026-10-03T09:17:02.662Z",
    sessionId: "s",
  }
  const line = (record: object) => transcriptEvents(JSON.stringify(record), session)

  it("ends the turn as recorded, dated by the record, saying nothing of what still runs", () => {
    expect(line(summary)).toEqual([
      {
        type: "turn-ended",
        agent: "claude",
        sessionId: "s",
        instance: "7",
        startedAt: Date.parse(summary.timestamp),
        outcome: "completed",
        recorded: true,
      },
    ])
  })

  it("ignores a subagent's", () => {
    expect(line({ ...summary, isSidechain: true })).toEqual([])
  })
})

const at = (second: number) => `2026-10-10T07:0${second}:00.000Z`

describe("a root tool call's result in the transcript", () => {
  // The hook names the input in its own order; the transcript keeps the model's.
  const hookInput = { command: "rm -f $OUT/*", timeout: 300000, description: "Tidy" }
  const use = (id: string, name = "Bash", input: object = hookInput) => ({
    type: "assistant",
    timestamp: at(1),
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  })
  const result = (id: string, second = 2) => ({
    type: "user",
    timestamp: at(second),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: true,
          content: "Permission for this command was denied ... the permission prompt timed out",
        },
      ],
    },
  })
  const read = (records: object[], calls: Calls = new Map()) =>
    records.flatMap((record) => transcriptEvents(JSON.stringify(record), session, calls))

  it("settles the request its hook asked, whatever order the input's keys came in", () => {
    const [asked] = decode({
      event: "PermissionRequest",
      seq: Date.parse(at(1)),
      instance: "7",
      env: {},
      payload: { session_id: "s", tool_name: "Bash", tool_input: hookInput },
    } as unknown as Report)
    const reordered = { description: "Tidy", command: "rm -f $OUT/*", timeout: 300000 }
    const settled = read([use("toolu_1", "Bash", reordered), result("toolu_1")])
    expect(settled).toEqual([
      {
        type: "attention-resolved",
        agent: "claude",
        sessionId: "s",
        instance: "7",
        startedAt: Date.parse(at(2)),
        requestId: (asked as { requestId: string }).requestId,
        actor: null,
        toolName: "Bash",
        loose: false,
        outcome: "settled",
      },
    ])
  })

  it("settles a question exactly, as another may still be asked", () => {
    const question = { questions: [{ question: "A?", options: [{ label: "x" }] }] }
    expect(read([use("toolu_1", "AskUserQuestion", question), result("toolu_1")])).toMatchObject([
      { requestId: callId(null, "AskUserQuestion", question), loose: false },
    ])
  })

  it("matches nested keys in any order", () => {
    const nested = { questions: [{ options: [{ label: "x" }], question: "A?" }] }
    const sorted = { questions: [{ question: "A?", options: [{ label: "x" }] }] }
    expect(callId(null, "AskUserQuestion", nested)).toBe(callId(null, "AskUserQuestion", sorted))
  })

  it("settles a plan loosely", () => {
    expect(read([use("toolu_1", "ExitPlanMode", { plan: "x" }), result("toolu_1")])).toMatchObject([
      { type: "attention-resolved", toolName: "ExitPlanMode", loose: true },
    ])
  })

  it("settles each call once, and none it never saw made", () => {
    const calls: Calls = new Map()
    expect(read([use("toolu_1"), result("toolu_1")], calls)).toHaveLength(1)
    expect(read([result("toolu_1", 3)], calls)).toEqual([])
    expect(read([result("toolu_2")], calls)).toEqual([])
    expect(calls.size).toBe(0)
  })

  it("forgets a subagent's calls, which its own transcript keeps", () => {
    expect(read([{ ...use("toolu_1"), isSidechain: true }, result("toolu_1")])).toEqual([])
  })

  it("settles the call before the interruption that ends the turn", () => {
    const interrupted = result("toolu_1")
    interrupted.message.content.push({
      type: "text",
      text: "[Request interrupted by user for tool use]",
    } as never)
    expect(read([use("toolu_1"), interrupted]).map(({ type }) => type)).toEqual([
      "attention-resolved",
      "turn-ended",
    ])
  })
})
