import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "../../test.js"
import { loadProbe } from "../../testing/probes.js"
import { transcripts } from "./transcripts.js"

const { records } = loadProbe(import.meta.dirname, "rollout.probe.json") as { records: object[] }
const items = (lines: readonly object[]) =>
  lines.flatMap((line) => transcripts.items(JSON.stringify(line)))
const item = (payload: object) => ({
  timestamp: "2026-09-29T20:50:21.802Z",
  type: "response_item",
  payload,
})

describe("Codex's rollout, as captured", () => {
  it("gives the tool call and its output, and leaves developer messages out", () => {
    const [call, output, ...rest] = items(records)
    expect(rest).toEqual([])
    expect(call).toMatchObject({ role: "assistant", kind: "tool-call", tool: "exec" })
    expect(output).toMatchObject({ role: "tool", kind: "tool-result", call: call?.call })
    expect(output?.text).toBe("<text>\n<text>\n<text>")
  })
})

const shell = loadProbe(import.meta.dirname, "shell.probe.json") as {
  scenarios: { [name: string]: object[] }
}

describe("Codex's shell-mode commands, as captured", () => {
  const ran = (name: string) => items(shell.scenarios[name]!)

  it("read as the person's `!command` and a Bash run, whose result pairs with its call", () => {
    const [said, call, result, ...rest] = ran("multiline")
    expect(rest).toEqual([])
    expect(said).toMatchObject({ role: "user", kind: "text", text: "!echo first\necho second" })
    expect(call).toMatchObject({
      role: "assistant",
      kind: "tool-call",
      tool: "Bash",
      text: JSON.stringify({ command: "echo first\necho second" }),
    })
    expect(call?.call).not.toBeNull()
    expect(result).toMatchObject({ role: "tool", kind: "tool-result", text: "first\nsecond" })
    expect(result?.call).toBe(call?.call)
  })

  it("leave out the event that records the same command beside the message", () => {
    expect(ran("stderr")).toHaveLength(3)
  })

  it("show the output, and the exit code when it is not zero", () => {
    expect(ran("stderr")[2]?.text).toBe("out-line\nerr-line")
    expect(ran("failed")[2]?.text).toBe("before\n[exit code 3]")
    expect(ran("missing")[2]?.text).toBe(
      "/bin/bash: line 1: no-such-command-here: command not found\n[exit code 127]",
    )
    expect(ran("aborted")[2]?.text).toBe("command aborted by user\n[exit code -1]")
  })

  it("say so when a command printed nothing, and pair its result without an id", () => {
    const [, call, result] = ran("empty")
    expect(result?.text).toBe("(no output)")
    expect(call?.call).toBeNull()
    expect(result?.call).toBeNull()
  })

  it("cut long output short, and say so", () => {
    const [, , result] = items([
      item({
        type: "message",
        id: "m1",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `<user_shell_command>\n<command>\nseq 1 4000\n</command>\n<result>\nExit code: 0\nDuration: 0.0192 seconds\nOutput:\n${"1234567\n".repeat(4000)}\n</result>\n</user_shell_command>`,
          },
        ],
      }),
    ])
    expect(result).toMatchObject({ truncated: true })
    expect(result?.text).toHaveLength(16_384)
  })
})

describe("Codex's rollout records", () => {
  it("give the person's and the agent's text, but not the context Codex adds", () => {
    expect(
      items([
        item({ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }),
        item({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>\n</environment_context>" }],
        }),
        item({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "yo" }],
        }),
        item({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md instructions for /p" }],
        }),
        item({ type: "message", role: "user", content: [{ type: "input_text", text: "<skill>" }] }),
        item({ type: "reasoning", summary: [] }),
      ]).map(({ role, text }) => `${role}: ${text}`),
    ).toEqual(["user: hi", "assistant: yo"])
  })

  it("give a function call's arguments, and its text output", () => {
    const [call, output] = items([
      item({ type: "function_call", name: "shell", arguments: '{"cmd":"ls"}', call_id: "c1" }),
      item({ type: "function_call_output", call_id: "c1", output: "a\nb" }),
    ])
    expect(call).toMatchObject({ tool: "shell", text: '{"cmd":"ls"}' })
    expect(output).toMatchObject({ text: "a\nb", call: call?.call })
  })
})

describe("Codex's transcripts", () => {
  it("are the session's rollout, and a subagent's named for its thread, on its day or later", async () => {
    const sessions = mkdtempSync(join(tmpdir(), "novadeck-codex-rollouts-"))
    try {
      const day = (date: string) => {
        const folder = join(sessions, ...date.split("-"))
        mkdirSync(folder, { recursive: true })
        return folder
      }
      const root = join(day("2020-09-30"), "rollout-2020-09-30T23-05-15-s1.jsonl")
      const child = join(day("2020-09-30"), "rollout-2020-09-30T23-06-00-a7.jsonl")
      const later = join(day("2020-10-01"), "rollout-2020-10-01T00-10-00-a9.jsonl")
      for (const file of [root, child, later]) writeFileSync(file, "")
      await expect(transcripts.locate(root, "s1", null)).resolves.toBe(root)
      await expect(transcripts.locate(root, "s1", "a7")).resolves.toBe(child)
      await expect(transcripts.locate(root, "s1", "a9")).resolves.toBe(later)
      // Resumed long after it began, its new subagents start today.
      const now = new Date()
      const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
        .map((part) => String(part).padStart(2, "0"))
        .join("-")
      const resumed = join(day(today), "rollout-now-b3.jsonl")
      writeFileSync(resumed, "")
      await expect(transcripts.locate(root, "s1", "b3")).resolves.toBe(resumed)
      await expect(transcripts.locate(root, "s1", "a8")).resolves.toBeUndefined()
    } finally {
      rmSync(sessions, { recursive: true, force: true })
    }
  })
})

describe("Codex's messages between agents", () => {
  it("are another agent's message to this one, named by its path", () => {
    expect(
      items([
        item({
          type: "agent_message",
          author: "/root",
          recipient: "/root/review",
          content: [
            { type: "input_text", text: "Check the diff." },
            { type: "encrypted_content", encrypted_content: "x" },
          ],
        }),
      ]),
    ).toMatchObject([{ role: "agent", kind: "text", text: "Check the diff.", author: "/root" }])
  })
})
