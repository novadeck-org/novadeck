import type { HarnessEvent } from "@novadeck/harness-core/events"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { hook } from "./report.test-support.js"
import { transcriptEvents } from "./transcript-watch.js"

type Hook = { event: string; payload: Record<string, unknown> }
const probe = loadProbe(import.meta.dirname, "shells.probe.json") as {
  scenarios: {
    "three-shells": {
      ids: [string, string, string]
      commands: [string, string, string]
      hooks: Hook[]
      queued: string[]
    }
  }
}
const { ids, commands, hooks, queued } = probe.scenarios["three-shells"]
const [a, c, b] = ids

const shellEvents = (events: readonly HarnessEvent[]) =>
  events.flatMap((event) =>
    event.type === "shell-started" || event.type === "shell-ended" || event.type === "shells-listed"
      ? [event]
      : [],
  )
const told = (at: number) => shellEvents(hook(hooks[at]!.event, hooks[at]!.payload))
const session = { sessionId: "s", instance: "7" }

describe("Claude Code's background shells, as captured", () => {
  it("starts a shell with the task id its Bash result names and the command it was given", () => {
    for (const [index, id] of [a, c, b].entries())
      expect(told(index)).toMatchObject([
        { type: "shell-started", id, command: commands[[0, 1, 2][index]!] },
      ])
  })

  it("lists the shells its Stop leaves running", () => {
    expect(told(3)).toMatchObject([{ type: "shells-listed", ids: [a, c, b] }])
  })

  it("ends a shell by the notification that starts a turn, with the exit code its summary gives", () => {
    expect(told(4)).toMatchObject([{ type: "shell-ended", id: c, code: 0 }])
    expect(told(5)).toMatchObject([{ type: "shell-ended", id: a, code: 3 }])
  })

  it("ends a shell the moment its notice is queued, which may be mid-turn", () => {
    const lines = queued
      .flatMap((line) => transcriptEvents(line, session))
      .filter(({ type }) => type === "shell-ended")
    expect(lines).toMatchObject([
      { type: "shell-ended", id: c, code: 0 },
      { type: "shell-ended", id: a, code: 3 },
    ])
  })

  it("ends a shell the agent stopped with no code, as TaskStop's result names it", () => {
    expect(told(6)).toMatchObject([{ type: "shell-ended", id: b, code: null }])
  })

  it("tells no shell for a Monitor, a subagent's call or a command that ended in its call", () => {
    const monitor = hook("PostToolUse", {
      tool_name: "Monitor",
      tool_input: { command: "tail -f x" },
      tool_response: { taskId: "mon1", timeoutMs: 60_000 },
    })
    expect(shellEvents(monitor)).toEqual([])
    const subagent = hook("PostToolUse", {
      agent_id: "sub1",
      tool_name: "Bash",
      tool_input: { command: "sleep 9", run_in_background: true },
      tool_response: { backgroundTaskId: "zz" },
    })
    expect(shellEvents(subagent)).toEqual([])
    const plain = hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_response: { stdout: "hi\n" },
    })
    expect(shellEvents(plain)).toEqual([])
  })

  it("lists no shells where its Stop lists no tasks, as an older release", () => {
    expect(shellEvents(hook("Stop", {}))).toEqual([])
  })
})

describe("Claude Code's background shells' output files", () => {
  const result = (content: unknown) =>
    JSON.stringify({
      type: "user",
      timestamp: "2026-11-06T13:29:05.542Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] },
    })
  const said = (path: string) =>
    `Command running in background with ID: bc4x20s7r. Output is being written to: ${path}. You will be notified when it completes — do not poll that file or sleep while waiting.`
  const outputs = (line: string) =>
    transcriptEvents(line, session).filter(({ type }) => type === "shell-output")

  it("tells the file from the result of the call that backgrounded the command", () => {
    const path = "/tmp/probe/tasks/bc4x20s7r.output"
    expect(outputs(result(said(path)))).toMatchObject([{ id: "bc4x20s7r", path }])
  })

  it("reads a result held as blocks of text, and a path of a Windows shape with spaces", () => {
    const path = String.raw`C:\Users\Ada Lovelace\AppData\Local\Temp\claude\tasks\bc4x20s7r.output`
    expect(outputs(result([{ type: "text", text: said(path) }]))).toMatchObject([
      { id: "bc4x20s7r", path },
    ])
  })

  it("tells the file of a task notification in the transcript, whether queued or a prompt", () => {
    const notice = `<task-notification>\n<task-id>b9</task-id>\n<output-file>/t/tasks/b9.output</output-file>\n<summary>done (exit code 0)</summary>\n</task-notification>`
    const queuedLine = JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-11-06T13:29:05.542Z",
      content: notice,
    })
    const promptLine = JSON.stringify({
      type: "user",
      timestamp: "2026-11-06T13:29:05.542Z",
      message: { role: "user", content: notice },
    })
    for (const line of [queuedLine, promptLine])
      expect(outputs(line)).toMatchObject([{ id: "b9", path: "/t/tasks/b9.output" }])
    expect(
      hook("UserPromptSubmit", { prompt: notice }).filter(({ type }) => type === "shell-output"),
    ).toMatchObject([{ id: "b9", path: "/t/tasks/b9.output" }])
  })

  it("tells nothing of a result that names no output file", () => {
    expect(outputs(result("hi\n"))).toEqual([])
    expect(
      outputs(result("Command running in background with ID: x. Output is being written")),
    ).toEqual([])
  })
})
