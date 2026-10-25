import { dirname, join } from "node:path"

import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { cutShort, transcripts } from "./transcripts.js"

const { scenarios } = loadProbe(import.meta.dirname, "transcript.probe.json") as {
  scenarios: { [name: string]: object[] }
}
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
      author: null,
      run: null,
      // Claude Code's marker for a stopped turn.
      interrupted: true,
    })
  })
})

const shell = loadProbe(import.meta.dirname, "shell.probe.json") as {
  scenarios: { [name: string]: object[] }
}

describe("Claude Code's shell-mode commands, as captured", () => {
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
      run: { kind: "run", title: "Ran", detail: "echo first" },
    })
    expect(call?.call).not.toBeNull()
    expect(result).toMatchObject({ role: "tool", kind: "tool-result", text: "first\nsecond" })
    expect(result?.call).toBe(call?.call)
  })

  it("show stdout, then stderr when there is some, and what a command that printed nothing says", () => {
    expect(ran("stderr")[2]?.text).toBe("out-line\nerr-line")
    // A failed command's output is all in stderr.
    expect(ran("failed")[2]?.text).toBe("before")
    expect(ran("missing")[2]?.text).toBe(
      "/bin/bash: line 1: no-such-command-here: command not found",
    )
    expect(ran("empty")[2]?.text).toBe("(Bash completed with no output)")
  })

  it("leave out the caveat written before a command that was still running", () => {
    expect(ran("caveat")).toEqual([])
  })

  it("cut long output short, and say so", () => {
    const [, , result] = items([
      { type: "user", uuid: "u1", message: { content: "<bash-input>seq 1 4000</bash-input>" } },
      {
        type: "user",
        parentUuid: "u1",
        message: {
          content: `<bash-stdout>${"1234567\n".repeat(4000)}</bash-stdout><bash-stderr></bash-stderr>`,
        },
      },
    ])
    expect(result).toMatchObject({ truncated: true })
    expect(result?.text).toHaveLength(16_384)
  })

  it("leave a person's own text that merely mentions the tags", () => {
    expect(
      items([{ type: "user", message: { content: "what is <bash-input>x</bash-input> for?" } }]),
    ).toHaveLength(1)
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
    expect(call).toMatchObject({
      kind: "tool-call",
      tool: "Bash",
      text: '{"command":"ls"}',
      run: { kind: "run", title: "Ran", detail: "ls" },
    })
    expect(result).toMatchObject({ run: null, interrupted: false })
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

describe("a Claude Code session whose last turn was cut short", () => {
  const user = (content: unknown, extra: object = {}) =>
    JSON.stringify({
      type: "user",
      message: { role: "user", content },
      ...extra,
    })
  const assistant = (content: unknown, model = "claude-opus-5-5") =>
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", model, content },
    })
  const result = user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }])
  const call = assistant([{ type: "tool_use", id: "t1", name: "Read", input: {} }])
  const synthetic = (text: string) => assistant([{ type: "text", text }], "<synthetic>")

  it("is cut when a tool's result or a prompt has no answer, also past the resume's own", () => {
    expect(cutShort([user("do it"), call, result])).toBe(true)
    expect(cutShort([user("do it")])).toBe(true)
    expect(cutShort([call, result, synthetic("No response requested.")])).toBe(true)
    expect(cutShort([call, result, JSON.stringify({ type: "last-prompt" }), "{cut", ""])).toBe(true)
  })

  it("is not when the turn finished, the person interrupted it or an error ended it", () => {
    expect(cutShort([user("do it"), assistant([{ type: "text", text: "Done." }])])).toBe(false)
    expect(
      cutShort([call, result, user([{ type: "text", text: "[Request interrupted by user]" }])]),
    ).toBe(false)
    expect(cutShort([call, result, synthetic("You've hit your session limit")])).toBe(false)
    expect(
      cutShort([
        user("go"),
        synthetic("No response requested."),
        assistant([{ type: "text", text: "On it." }]),
      ]),
    ).toBe(false)
  })

  it("is not when the agent's own step is last, as it may wait on the person", () => {
    expect(cutShort([user("do it"), call])).toBe(false)
  })

  it("leaves out records no turn answers", () => {
    const done = [user("do it"), assistant([{ type: "text", text: "Done." }])]
    expect(cutShort([...done, user("<local-command-stdout>x</local-command-stdout>")])).toBe(false)
    expect(cutShort([...done, user("meta", { isMeta: true })])).toBe(false)
    expect(cutShort([...done, user("side", { isSidechain: true })])).toBe(false)
  })
})
