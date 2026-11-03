import type { HarnessEvent } from "@novadeck/harness-core/events"
import type { Report } from "@novadeck/harness-core/report"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { hookReport } from "@novadeck/harness-core/testing/reports"
import { describe, expect, it } from "vitest"

import { decode } from "./decode.js"

type Payload = Report["payload"]
const probe = loadProbe(import.meta.dirname, "version.probe.json") as {
  version: string
  statusLines: Payload[]
}
const statusLine = (payload: Payload): readonly HarnessEvent[] =>
  decode(hookReport("agy", "StatusLine", payload, { seq: 5 }))
const versionOf = (events: readonly HarnessEvent[]) =>
  events.flatMap((event) => (event.type === "telemetry-observed" ? [event.version] : []))

describe("the version of Antigravity in its status line, as captured", () => {
  const [authenticating, initializing, idle, working, settled] = probe.statusLines

  it("is told with the telemetry of every snapshot that names a conversation", () => {
    expect(versionOf(statusLine(working!))).toEqual([probe.version])
    expect(versionOf(statusLine(settled!))).toEqual([probe.version])
  })

  it("is left out of a snapshot that names a conversation but no version", () => {
    expect(versionOf(statusLine({ ...working!, version: "" }))).toEqual([undefined])
    const { version: _, ...without } = working!
    expect(versionOf(statusLine(without))).toEqual([undefined])
  })

  it("is not read as the version of a conversation before there is one", () => {
    // The first snapshot has it empty, as the process authenticates; none names a session.
    expect(authenticating!.version).toBe("")
    for (const payload of [authenticating!, initializing!, idle!])
      expect(statusLine(payload)).toEqual([])
  })

  it("is in no hook's payload, which names the conversation and its files only", () => {
    const stop = hookReport("agy", "Stop", {
      conversationId: "50000000-0000-4000-8000-000000000001",
      executionNum: 0,
      fullyIdle: true,
    })
    expect(versionOf(decode(stop))).toEqual([])
  })
})
