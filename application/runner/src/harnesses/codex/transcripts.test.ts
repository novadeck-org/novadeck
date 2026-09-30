import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "../../test.js"
import { transcripts } from "./transcripts.js"

const { records } = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "rollout.probe.json"), "utf8"),
) as { records: object[] }
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
