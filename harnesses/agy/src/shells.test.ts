import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ActivityEvent } from "@novadeck/harness-core/events"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { followWords, planWords, shellEvents, type Calls } from "./shells.js"

// Captured on Linux, whose log URLs name no drive; on Windows Antigravity's carry one
// (`file:///C:/…`), as these are given here.
const lines = (
  loadProbe(import.meta.dirname, "shells.probe.json") as {
    scenarios: { "three-shells": { lines: string[] } }
  }
).scenarios["three-shells"].lines.map((line) =>
  process.platform === "win32" ? line.replaceAll("file:///", "file:///C:/") : line,
)
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

  it("ends a killed shell by the call's own step whose times come twice over, as from 1.5.7", () => {
    const times = "Created At: 2026-11-13T10:12:25+01:00\nCompleted At: 2026-11-13T10:12:25+01:00\n"
    const step = JSON.stringify({
      step_index: 15,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      created_at: "2026-11-13T09:12:25Z",
      content: `${times}${times}Task "${conversation}/task-6" cancelled.`,
    })
    expect(replay([step])).toMatchObject([
      { type: "shell-ended", id: `${conversation}/task-6`, code: null },
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

  it("tells the file a shell's output is in, as a path from the log's URL, in the step that starts it", () => {
    const output = replay().filter(({ type }) => type === "shell-output")
    expect(output).toMatchObject([
      { id: `${conversation}/task-2`, path: expect.stringMatching(/task-2\.log$/) },
      { id: `${conversation}/task-4`, path: expect.stringMatching(/task-4\.log$/) },
      { id: `${conversation}/task-6`, path: expect.stringMatching(/task-6\.log$/) },
    ])
    expect(output[0]).toMatchObject({
      path: expect.stringMatching(/[\\/]\.gemini[\\/]antigravity-cli[\\/]brain[\\/]/),
    })
  })

  const running = (url: string) => [
    JSON.stringify({
      step_index: 2,
      source: "MODEL",
      type: "GENERIC",
      status: "RUNNING",
      created_at: "2026-11-10T09:00:00Z",
      content: `Tool is running as a background task with task id: ${conversation}/task-2\nTask Description: sleep 9\nTask logs are available at: ${url}\n`,
    }),
  ]

  it("decodes a percent-encoded URL into the path it names", () => {
    const here =
      process.platform === "win32"
        ? "file:///C:/Users/a%20b/task-2.log"
        : "file:///home/a%20b/task-2.log"
    const [, output] = replay(running(here))
    expect(output).toMatchObject({
      type: "shell-output",
      path:
        process.platform === "win32" ? String.raw`C:\Users\a b\task-2.log` : "/home/a b/task-2.log",
    })
  })

  it("starts the shell all the same where its log URL is unreadable", () => {
    expect(replay(running("file://%zz"))).toMatchObject([{ type: "shell-started" }])
  })
})

describe("the words an Antigravity transcript records", () => {
  const step = (fields: object) =>
    JSON.stringify({
      step_index: 3,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-20T10:00:05Z",
      ...fields,
    })

  it("tells a planner response's content, dated by its step, with or without calls", () => {
    const words = {
      type: "words-written",
      agent: "agy",
      sessionId: session.sessionId,
      instance: "7",
      startedAt: Date.parse("2026-11-20T10:00:05Z"),
    }
    expect(planWords(step({ content: "Which one do you want?" }), session)).toEqual(words)
    expect(
      planWords(
        step({ content: "Let me look.", tool_calls: [{ name: "view_file", args: {} }] }),
        session,
      ),
    ).toEqual(words)
  })

  it("tells nothing for a step of calls alone, thinking alone, or a tool's own step", () => {
    expect(
      planWords(step({ tool_calls: [{ name: "view_file", args: {} }] }), session),
    ).toBeUndefined()
    expect(planWords(step({ thinking: "Hmm", content: "" }), session)).toBeUndefined()
    expect(
      planWords(step({ source: "MODEL", type: "GENERIC", content: "done" }), session),
    ).toBeUndefined()
  })
})

describe("the words Antigravity's follower tells", () => {
  it("dates them by when the line is read, not by the step's whole second", async () => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-agy-words-"))
    const path = join(folder, "transcript.jsonl")
    writeFileSync(path, "")
    const told: ActivityEvent[] = []
    const controller = new AbortController()
    const following = followWords({ ...session, transcript: path }, controller.signal, (event) =>
      told.push(event as ActivityEvent),
    )
    try {
      await new Promise((resolve) => setTimeout(resolve, 200))
      // A step dated seconds before it is written, as generation began then.
      const stepAt = new Date(Date.now() - 3000).toISOString().replace(/\.\d+Z$/, "Z")
      const before = Date.now()
      appendFileSync(
        path,
        `${JSON.stringify({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", created_at: stepAt, content: "Which?" })}\n`,
      )
      await expect.poll(() => told.length, { timeout: 5000 }).toBe(1)
      expect(told).toHaveLength(1)
      expect(told[0]!.startedAt).toBeGreaterThanOrEqual(before)
    } finally {
      controller.abort()
      await following
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
