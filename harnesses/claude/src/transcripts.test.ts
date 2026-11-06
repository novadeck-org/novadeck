import { dirname, join } from "node:path"

import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { transcriptLimits } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

import { transcripts, unwrapPasted } from "./transcripts.js"

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
      outcome: null,
      scripted: false,
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

describe("Claude Code's wrappers around the person's words", () => {
  const said = (content: string, extra: object = {}) =>
    transcripts.items(
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: "u0",
        timestamp: "2026-11-03T12:00:00.000Z",
        message: { role: "user", content },
        ...extra,
      }),
    )
  const texts = (content: string) => said(content).map(({ role, kind, text }) => [role, kind, text])

  it("put a wrapped paste back where it was pasted, between the words typed around it", () => {
    expect(
      unwrapPasted(
        'Read this: \n\n<pasted_content id="4f2a">\nfirst\nsecond\n</pasted_content id="4f2a">\n and fix it',
      ),
    ).toBe("Read this: first\nsecond and fix it")
    expect(
      unwrapPasted(
        '<pasted_content id="a">\none\n</pasted_content id="a">\n and <pasted_content id="b">\ntwo\n</pasted_content id="b">\n',
      ),
    ).toBe("one and two")
    expect(unwrapPasted("no wrapper here")).toBe("no wrapper here")
    expect(
      texts('\n\n<pasted_content id="9b1c">\nonly a paste\n</pasted_content id="9b1c">\n'),
    ).toEqual([["user", "text", "only a paste"]])
  })

  it("read a slash command as the line typed, in either order of its tags", () => {
    expect(
      texts(
        "<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args></command-args>",
      ),
    ).toEqual([["user", "text", "/mcp"]])
    expect(
      texts(
        "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>the open PR</command-args>",
      ),
    ).toEqual([["user", "text", "/review the open PR"]])
  })

  it("read what a slash command printed as a result, without its styles, and nothing for none", () => {
    expect(
      said(
        "<local-command-stdout>\u001b[1mConnected\u001b[22m to linear.</local-command-stdout>",
      ).map(({ role, kind, text }) => [role, kind, text]),
    ).toEqual([["tool", "tool-result", "Connected to linear."]])
    expect(said("<local-command-stdout>(no content)</local-command-stdout>")).toEqual([])
    expect(said("<local-command-stderr></local-command-stderr>")).toEqual([])
  })

  it("read shell output without the terminal's colours", () => {
    expect(
      said(
        "<bash-stdout>\u001b[31merror\u001b[0m: no</bash-stdout><bash-stderr></bash-stderr>",
      ).map(({ text }) => text),
    ).toEqual(["error: no"])
  })

  it("read a shell command that couldn't start by its stderr alone", () => {
    expect(texts("<bash-stderr>Command failed: folder deleted</bash-stderr>")).toEqual([
      ["tool", "tool-result", "Command failed: folder deleted"],
    ])
  })

  it("read a paste whose closing tag leaves out its id the same", () => {
    expect(unwrapPasted('a: \n\n<pasted_content id="x">\nbody\n</pasted_content>\n')).toBe(
      "a: body",
    )
  })

  it("read the person's text blocks as their text content", () => {
    const blocks = (text: string) =>
      transcripts
        .items(
          JSON.stringify({
            type: "user",
            uuid: "u1",
            timestamp: "2026-11-03T12:00:00.000Z",
            message: {
              role: "user",
              content: [
                { type: "image", source: {} },
                { type: "text", text },
              ],
            },
          }),
        )
        .map(({ role, kind, text: shown }) => [role, kind, shown])
    expect(blocks("<command-name>/mcp</command-name>")).toEqual([["user", "text", "/mcp"]])
    expect(blocks('<novadeck-messages note="x">hi</novadeck-messages>')).toEqual([])
    expect(blocks('see \n\n<pasted_content id="y">\nthis\n</pasted_content id="y">\n')).toEqual([
      ["user", "text", "see this"],
    ])
  })

  it("strip the terminal's moves from what a slash command printed, not only its styles", () => {
    expect(
      said("<local-command-stdout>\u001b[2K\u001b[?25hDone\u001b[0m</local-command-stdout>").map(
        ({ text }) => text,
      ),
    ).toEqual(["Done"])
  })

  it("leave out agents' messages Novadeck handed the agent as a prompt", () => {
    expect(said('<novadeck-messages note="x"><message>hi</message></novadeck-messages>')).toEqual(
      [],
    )
  })
})
