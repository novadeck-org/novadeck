import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { describe, expect, it } from "../../test.js"
import { transcripts } from "./transcripts.js"

const { scenarios } = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "transcript.probe.json"), "utf8"),
) as { scenarios: { [name: string]: object[] } }
const items = (records: readonly object[]) =>
  records.flatMap((record) => transcripts.items(JSON.stringify(record)))

describe("Claude Code's transcript, as captured", () => {
  it("gives the person's text, the tool call and its result, and leaves thinking out", () => {
    expect(items(scenarios.deny!).map(({ role, kind }) => `${role} ${kind}`)).toEqual([
      "user text",
      "assistant tool-call",
      "tool tool-result",
      "user text",
    ])
    expect(items(scenarios.deny!).at(-1)).toEqual({
      at: Date.parse("2026-09-29T22:13:37.834Z"),
      role: "user",
      kind: "text",
      text: "[Request interrupted by user for tool use]",
      truncated: false,
      tool: null,
      call: null,
    })
  })
})

describe("Claude Code's transcript records", () => {
  it("pair a tool's result with its call, by a ref of the call's id", () => {
    const [call, result] = items([
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "a" }] },
          ],
        },
      },
    ])
    expect(call).toMatchObject({ kind: "tool-call", tool: "Bash", text: '{"command":"ls"}' })
    expect(result).toMatchObject({ kind: "tool-result", text: "a", call: call?.call })
    expect(call?.call).toMatch(/^[\w-]{16}$/)
  })

  it("leave out what Claude Code writes for itself, and anything not a record", () => {
    expect(items([{ type: "user", isMeta: true, message: { content: "caveat" } }])).toEqual([])
    expect(
      items([{ type: "user", isCompactSummary: true, message: { content: "summary" } }]),
    ).toEqual([])
    expect(
      items([{ type: "user", message: { content: "<task-notification>\n</task-notification>" } }]),
    ).toEqual([])
    expect(transcripts.items("not json")).toEqual([])
    expect(transcripts.items("[]")).toEqual([])
  })

  it("cut long text short, and say so", () => {
    const [long] = items([{ type: "assistant", message: { content: "x".repeat(20_000) } }])
    expect(long).toMatchObject({ truncated: true })
    expect(long?.text).toHaveLength(16_384)
  })
})

describe("Claude Code's transcripts", () => {
  it("are the session's, and beside it one per subagent", async () => {
    const root = "/home/user/.claude/projects/-p/s1.jsonl"
    await expect(transcripts.locate(root, "s1", null)).resolves.toBe(root)
    await expect(transcripts.locate(root, "s1", "a1b2")).resolves.toBe(
      join(dirname(root), "s1", "subagents", "agent-a1b2.jsonl"),
    )
    await expect(transcripts.locate(root, "s1", "../x")).resolves.toBeUndefined()
  })
})
