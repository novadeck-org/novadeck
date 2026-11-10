import type { HarnessEvent } from "@novadeck/harness-core/events"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { rolloutEvents, type Commands } from "./rollout.js"

const lines = (
  loadProbe(import.meta.dirname, "shells.probe.json") as {
    scenarios: { "three-shells": { lines: string[] } }
  }
).scenarios["three-shells"].lines
const session = { sessionId: "s", instance: "7" }

const replay = (from: readonly string[] = lines): HarnessEvent[] => {
  const commands: Commands = new Map()
  return from.flatMap((line) => [...rolloutEvents(line, session, commands)])
}
const shells = (events: readonly HarnessEvent[]) =>
  events.filter(({ type }) => type === "shell-started" || type === "shell-ended")

describe("Codex's background shells, as captured", () => {
  it("starts a shell when a command's output says its session goes on, with the command it was called with", () => {
    const started = shells(replay()).filter(({ type }) => type === "shell-started")
    expect(started).toMatchObject([
      { id: "53902", command: expect.stringContaining("exit 3") },
      { id: "26916", command: expect.stringContaining("exit 0") },
      { id: "99018", command: expect.stringContaining("while true") },
    ])
    // When it was called, not when its output came back.
    const call = JSON.parse(lines[0]!) as { timestamp: string }
    expect(started[0]!.startedAt).toBe(Date.parse(call.timestamp))
  })

  it("ends a shell with the exit code of its item, and none for one /stop closed", () => {
    const ended = shells(replay()).filter(({ type }) => type === "shell-ended")
    expect(ended).toMatchObject([
      { id: "26916", code: 0 },
      { id: "53902", code: 3 },
      { id: "99018", code: null },
    ])
  })

  it("tells no shell for a command that ended within its call", () => {
    const quick = [
      JSON.stringify({
        timestamp: "2026-11-10T09:00:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"echo hi"}',
          call_id: "c1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-10T09:00:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c1",
          output: "Chunk ID: a\nWall time: 0.0 seconds\nProcess exited with code 0\nOutput:\nhi\n",
        },
      }),
    ]
    expect(shells(replay(quick))).toEqual([])
  })

  it("starts a shell once, though a later call to poll its session says it still runs", () => {
    const poll = JSON.stringify({
      timestamp: "2026-11-10T09:10:50.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_poll",
        output: "Chunk ID: b\nProcess running with session ID 53902\nOutput:\n",
      },
    })
    expect(shells(replay([...lines.slice(0, 2), poll])).length).toBe(1)
  })
})
