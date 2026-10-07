import { describe, expect, it } from "../../test.js"
import { loadProbe } from "../../testing/probes.js"
import { transcriptEvents } from "./transcript.js"

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
