import { dirname, join } from "node:path"

import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { transcriptLimits } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

import { transcripts } from "./transcripts.js"

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

describe("Claude Code's interruption records", () => {
  const said = (content: unknown) =>
    items([{ type: "user", timestamp: "2026-09-29T22:13:37.834Z", message: { content } }])
  const marker = "[Request interrupted by user for tool use]"

  it("read as interrupted, however it wrote them", () => {
    for (const content of [marker, "  [Request interrupted by user]\n"])
      expect(said(content)).toMatchObject([{ role: "user", interrupted: true }])
    expect(said([{ type: "text", text: marker }])).toMatchObject([{ interrupted: true }])
  })

  it("are nothing else, as text that only starts like one", () => {
    expect(said(`${marker} and more`)).toMatchObject([{ role: "user", interrupted: false }])
    expect(
      items([
        { type: "assistant", timestamp: "2026-09-29T22:13:37.834Z", message: { content: marker } },
      ]),
    ).toMatchObject([{ role: "assistant", interrupted: false }])
  })
})

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
    expect(result?.text).toHaveLength(transcriptLimits.text)
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
    expect(long?.text).toHaveLength(transcriptLimits.text)
  })
})

const queued = loadProbe(import.meta.dirname, "queued.probe.json") as {
  scenarios: { [name: string]: object[] }
}

// A queued_command attachment, as Claude Code writes one for a prompt it takes into the
// running turn, with `fields` over its own.
const queuedCommand = (fields: object) => ({
  type: "attachment",
  timestamp: "2026-10-26T10:16:20.200Z",
  attachment: {
    type: "queued_command",
    prompt: "Also check the logs",
    commandMode: "prompt",
    origin: { kind: "human" },
    timestamp: "2026-10-26T10:16:20.157Z",
    ...fields,
  },
})

describe("Claude Code's prompts taken into a running turn", () => {
  it("read as the person's, after the tool's result and before the reply that answers them", () => {
    expect(
      items(queued.scenarios.absorbed!).map(({ role, kind, text }) => `${role} ${kind}: ${text}`),
    ).toEqual([
      "user text: First quick",
      'assistant tool-call: {"query":"select:SendMessage"}',
      "tool tool-result: ",
      "user text: Second quick",
      "assistant text: Did first. Did second.",
    ])
  })

  it("take the time the person gave the prompt, not when the turn took it", () => {
    expect(items([queuedCommand({})])).toEqual([
      expect.objectContaining({
        role: "user",
        kind: "text",
        text: "Also check the logs",
        at: Date.parse("2026-10-26T10:16:20.157Z"),
      }),
    ])
  })

  it("read a prompt with an image as its text", () => {
    const prompt = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } },
      { type: "text", text: "What is on this screenshot?" },
    ]
    expect(items([queuedCommand({ prompt })]).map(({ text }) => text)).toEqual([
      "What is on this screenshot?",
    ])
  })

  it("leave out what comes the same way but isn't the person's", () => {
    for (const fields of [
      { origin: { kind: "task-notification" } },
      { origin: { kind: "peer" } },
      { origin: { kind: "coordinator" } },
      { origin: undefined },
      { isMeta: true },
      { commandMode: "task-notification" },
      { prompt: "<task-notification>\n<status>completed</status>\n</task-notification>" },
    ])
      expect(items([queuedCommand(fields)])).toEqual([])
    expect(items([{ ...queuedCommand({}), isMeta: true }])).toEqual([])
    expect(items([{ type: "attachment", attachment: { type: "total_tokens_reminder" } }])).toEqual(
      [],
    )
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
