import type { ActivityEvent } from "@novadeck/harness-core/events"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { shellEvents, type Calls } from "./shells.js"

const lines = (
  loadProbe(import.meta.dirname, "shells.probe.json") as {
    scenarios: { "three-shells": { lines: string[] } }
  }
).scenarios["three-shells"].lines
const session = { sessionId: "b0000000-0000-4000-8000-000000000001", instance: "7" }
const conversation = session.sessionId

const replay = (from: readonly string[] = lines): ActivityEvent[] => {
  const calls: Calls = new Map()
  return from.flatMap((line) => [...shellEvents(line, session, calls)])
}

describe("Antigravity's background shells, as captured", () => {
  it("starts a shell when its command goes to the background, by the task id and command its step names", () => {
    const started = replay().filter(({ type }) => type === "shell-started")
    expect(started).toMatchObject([
      { id: `${conversation}/task-2`, command: expect.stringContaining("exit 3") },
      { id: `${conversation}/task-4`, command: expect.stringContaining("exit 0") },
      { id: `${conversation}/task-6`, command: expect.stringContaining("while true") },
    ])
    // At the step's own time.
    expect(started[0]!.startedAt).toBe(Date.parse("2026-11-10T09:12:05Z"))
  })

  it("ends a shell by the message that says it finished, with its exit code", () => {
    const ended = replay().filter(({ type }) => type === "shell-ended")
    expect(ended).toMatchObject([
      { id: `${conversation}/task-4`, code: 0 },
      { id: `${conversation}/task-2`, code: 3 },
      // Killed: the call's own step, and the message that says it was canceled, with no code.
      { id: `${conversation}/task-6`, code: null },
      { id: `${conversation}/task-6`, code: null },
    ])
  })

  it("starts no shell for a background step of a tool that is no command", () => {
    const timer = [
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-10T09:00:00Z",
        tool_calls: [{ name: "schedule", args: { DurationSeconds: 60 } }],
      }),
      JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        status: "RUNNING",
        created_at: "2026-11-10T09:00:00Z",
        content: `Tool is running as a background task with task id: ${conversation}/task-2\nTask Description: wake me\nTask logs are available at: file:///x.log\n`,
      }),
    ]
    expect(replay(timer)).toEqual([])
  })
})
