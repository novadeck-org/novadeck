import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { transcriptLimits } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

import { transcripts } from "./transcripts.js"

const { records } = loadProbe(import.meta.dirname, "rollout.probe.json") as { records: object[] }
const items = (lines: readonly object[]) =>
  lines.flatMap((line) => transcripts.items(JSON.stringify(line)))
const item = (payload: object) => ({
  timestamp: "2026-09-29T20:50:21.802Z",
  type: "response_item",
  payload,
})

describe("what Codex says between turns", () => {
  const context = (mode: string, approval_policy: string) => ({
    timestamp: "2026-09-29T20:50:21.802Z",
    type: "turn_context",
    payload: { approval_policy, collaboration_mode: { mode } },
  })

  it("says plan mode, else its approval policy, the usual one as the default", () => {
    expect(items([context("plan", "on-request")])).toMatchObject([
      { role: "note", note: { type: "mode", mode: "plan" } },
    ])
    expect(items([context("default", "on-request")])).toMatchObject([
      { note: { type: "mode", mode: "default" } },
    ])
    expect(items([context("default", "never")])).toMatchObject([
      { note: { type: "mode", mode: "never" } },
    ])
  })

  it("says nothing of a turn that names no mode", () => {
    expect(items([{ type: "turn_context", payload: {} }])).toEqual([])
  })

  it("says a compaction, its message its text", () => {
    expect(items([{ type: "compacted", payload: { message: "The summary" } }])).toMatchObject([
      { role: "note", note: { type: "compaction" }, text: "The summary" },
    ])
  })
})

describe("Codex's rollout, as captured", () => {
  it("gives the tool call and its output, and leaves developer messages out", () => {
    const [call, output, ...rest] = items(records).filter(({ role }) => role !== "note")
    expect(rest).toEqual([])
    expect(call).toMatchObject({
      role: "assistant",
      kind: "tool-call",
      tool: "exec",
      run: { kind: "run", title: "Ran" },
    })
    expect(output).toMatchObject({ role: "tool", kind: "tool-result", call: call?.call })
    expect(output?.text).toBe("<text>\n<text>\n<text>")
  })
})

const shell = loadProbe(import.meta.dirname, "shell.probe.json") as {
  scenarios: { [name: string]: object[] }
}

describe("Codex's interruptions", () => {
  const { scenarios } = loadProbe(import.meta.dirname, "ask.probe.json") as {
    scenarios: { [name: string]: { [key: string]: object[] } }
  }
  const aborted = (reason: string) => ({
    timestamp: "2026-10-20T10:00:00.000Z",
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: "t1", reason },
  })

  it("read as the person's interruption, where the turn ended, as captured", () => {
    const [interrupted, ...rest] = items(scenarios["rui-esc-then-prompt"]!.rolloutFinal!).filter(
      (each) => each.interrupted,
    )
    expect(rest).toEqual([])
    expect(interrupted).toMatchObject({ role: "user", kind: "text", interrupted: true })
  })

  it("are only an abort the person made, and nothing else Codex tells of it", () => {
    expect(items([aborted("interrupted")])).toMatchObject([
      { at: Date.parse("2026-10-20T10:00:00.000Z"), role: "user", interrupted: true },
    ])
    expect(items([aborted("replaced")])).toEqual([])
    // The message it tells the model of the abort with is a developer's, which stays out.
    const told = item({
      type: "message",
      role: "developer",
      content: [
        {
          type: "input_text",
          text: "<turn_aborted>\nThe previous turn was interrupted on purpose.\n</turn_aborted>",
        },
      ],
    })
    expect(items([told])).toEqual([])
    // Claude Code's marker is no record of Codex's.
    expect(
      items([
        item({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "[Request interrupted by user]" }],
        }),
      ]),
    ).toMatchObject([{ role: "user", interrupted: false }])
  })
})

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
      run: { kind: "run", title: "Ran", detail: "echo first" },
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
    expect(result?.text).toHaveLength(transcriptLimits.text)
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

  it("give a prompt with an image as its text, without the tags naming the image's file", () => {
    const image = { type: "input_image", image_url: "data:image/png;base64,iVBORw0K" }
    expect(
      items([
        item({
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: '<image name=[Image #1] path="/p/picture.png">' },
            image,
            { type: "input_text", text: "</image>" },
            { type: "input_text", text: "Look at this picture [Image #1]" },
          ],
        }),
        item({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "what does </image> close?" }],
        }),
      ]).map(({ text }) => text),
    ).toEqual(["Look at this picture [Image #1]", "what does </image> close?"])
  })

  it("give a function call's arguments, and its text output", () => {
    const [call, output] = items([
      item({ type: "function_call", name: "shell", arguments: '{"cmd":"ls"}', call_id: "c1" }),
      item({ type: "function_call_output", call_id: "c1", output: "a\nb" }),
    ])
    expect(call).toMatchObject({
      tool: "shell",
      text: '{"cmd":"ls"}',
      run: { kind: "run", title: "Ran", detail: "ls" },
    })
    expect(output).toMatchObject({ text: "a\nb", call: call?.call })
  })

  it("name an MCP tool's call for its server, as its rollout gives it apart", () => {
    const [call] = items([
      item({
        type: "function_call",
        name: "send",
        namespace: "mcp__novadeck",
        arguments: '{"to":"t2","text":"hi"}',
        call_id: "c1",
      }),
    ])
    expect(call).toMatchObject({
      tool: "mcp__novadeck__send",
      run: { kind: "agent", title: "Messaged t2", detail: "hi" },
    })
  })
})

describe("Codex's calls of the Responses API's own tools, as the 0.166.0 binary names them", () => {
  it("give a shell call's command as a run, whose output pairs with it", () => {
    const [call, output] = items([
      item({
        type: "local_shell_call",
        call_id: "c1",
        status: "completed",
        action: { type: "exec", command: ["bash", "-lc", "ls -la"], timeout_ms: 1000 },
      }),
      item({ type: "function_call_output", call_id: "c1", output: "a\nb" }),
    ])
    expect(call).toMatchObject({
      kind: "tool-call",
      tool: "local_shell",
      run: { kind: "run", title: "Ran", detail: "ls -la" },
    })
    expect(output).toMatchObject({ text: "a\nb", call: call?.call })
    const [argv] = items([
      item({
        type: "local_shell_call",
        id: "c2",
        action: { type: "exec", command: ["git", "status"] },
      }),
    ])
    expect(argv).toMatchObject({ run: { detail: "git status" } })
    const [windows] = items([
      item({
        type: "local_shell_call",
        call_id: "c3",
        action: {
          type: "exec",
          command: ["powershell.exe", "-NoProfile", "-Command", "Get-ChildItem"],
        },
      }),
    ])
    expect(windows).toMatchObject({ run: { detail: "Get-ChildItem" } })
  })

  it("give a web search by what it did: a query, a page opened, or a pattern in one", () => {
    // Done once recorded: its result is its status, so it neither runs on nor reads as lost.
    const [call, result] = items([
      item({
        type: "web_search_call",
        id: "ws0",
        status: "completed",
        action: { type: "search", query: "q" },
      }),
    ])
    expect(result).toMatchObject({ kind: "tool-result", text: "completed", call: call?.call })
    const search = (action: object) =>
      items([item({ type: "web_search_call", id: "ws1", status: "completed", action })])[0]
    expect(search({ type: "search", query: "vitest shard" })).toMatchObject({
      kind: "tool-call",
      tool: "web_search",
      run: { kind: "web", title: "Searched the web", detail: "vitest shard" },
    })
    expect(search({ type: "search", queries: ["a", "b"] })).toMatchObject({
      run: { title: "Searched the web", detail: "a, b" },
    })
    expect(search({ type: "open_page", url: "https://example.com" })).toMatchObject({
      run: { title: "Opened a page", detail: "https://example.com" },
    })
    expect(
      search({ type: "find_in_page", url: "https://example.com", pattern: "shard" }),
    ).toMatchObject({
      run: { title: "Searched a page", detail: "shard in https://example.com" },
    })
    expect(search({ type: "find_in_page", pattern: "shard" })).toMatchObject({
      run: { title: "Searched a page", detail: "shard" },
    })
    expect(search({ type: "other" })).toMatchObject({
      run: { title: "Searched the web", detail: "" },
    })
  })

  it("give an image the model made by its prompt, never the image's data", () => {
    const [call, result] = items([
      item({
        type: "image_generation_call",
        id: "ig1",
        status: "completed",
        revised_prompt: "a crow on a rack",
        result: "iVBORw0KGgo=",
      }),
    ])
    expect(call).toMatchObject({
      kind: "tool-call",
      tool: "image_generation",
      run: { title: "Generated an image", detail: "a crow on a rack" },
    })
    expect(result).toMatchObject({ kind: "tool-result", text: "completed" })
    expect(JSON.stringify([call, result])).not.toContain("iVBORw0KGgo=")
  })
})

const asked = loadProbe(import.meta.dirname, "ask.probe.0.166.0.json") as {
  scenarios: { [name: string]: { rollout: object[] } }
}

describe("Codex's answers to its async questions, as captured", () => {
  const said = (name: string) =>
    items(asked.scenarios[name]!.rollout).map(({ role, kind, text }) => `${role} ${kind}: ${text}`)

  it("read as the person's words, the question then the answer, after the question's call", () => {
    expect(said("rui-async-panel-digit-2")).toEqual([
      "user text: Ask me about the button",
      expect.stringMatching(/^assistant tool-call: /),
      'tool tool-result: {"accepted":true}',
      "user text: Re: Which color should the button be?\nGreen",
      "assistant text: Thanks for the answer.",
    ])
  })

  it("read one message for each question answered, as Codex replies to each on its own", () => {
    expect(said("rui-async-panel-two-questions").filter((line) => line.startsWith("user"))).toEqual(
      [
        "user text: Ask me about the button",
        "user text: Re: Which color should the button be?\nBlue",
        "user text: Re: What should its label say?\nLarge",
      ],
    )
  })

  it("never show the reply's own markup", () => {
    for (const name of Object.keys(asked.scenarios))
      for (const line of said(name)) expect(line).not.toContain("question_reply")
  })
})

describe("Codex's reply to async questions", () => {
  const reply = (answers: readonly object[]) =>
    item({
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: `<send_user_message_question_reply>\n${JSON.stringify(answers)}\n</send_user_message_question_reply>`,
        },
      ],
    })
  const place = (part: number) => JSON.stringify(["request_user_input_async", "call_a", part])

  it("gives every question it answers, set apart by a blank line", () => {
    expect(
      items([
        reply([
          { answer: "Blue", question: "Which color?", questionItemId: place(0) },
          { answer: "Large", question: "Which size?", questionItemId: place(1) },
        ]),
      ]).map(({ role, text }) => `${role}: ${text}`),
    ).toEqual(["user: Re: Which color?\nBlue\n\nRe: Which size?\nLarge"])
  })

  it("gives the answer alone where it names no question", () => {
    expect(items([reply([{ answer: "Blue", questionItemId: place(0) }])])[0]?.text).toBe("Blue")
  })

  it("says so where an answer holds no text, rather than showing the reply as written", () => {
    expect(
      items([
        reply([{ answer: "", question: "Which color?", questionItemId: place(0) }]),
        reply([{ questionItemId: place(0) }]),
      ]).map(({ text }) => text),
    ).toEqual(["Re: Which color?\n(no answer)", "(no answer)"])
  })

  it("stays as written where its items are not as probed", () => {
    const [entry] = items([reply([{ answer: "Blue" }])])
    expect(entry?.text).toMatch(/^<send_user_message_question_reply>/)
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

  it("are the session's rollout where Codex keeps it when the named one holds none", async () => {
    const home = mkdtempSync(join(tmpdir(), "novadeck-codex-home-"))
    try {
      const id = "5b0e7d1c-4f3a-4c2b-9d8e-1a2b3c4d5e6f"
      const folder = (...parts: string[]) => {
        const path = join(home, ...parts)
        mkdirSync(path, { recursive: true })
        return path
      }
      const reported = join(folder("sessions", "2026", "11", "06"), `rollout-x-${id}.jsonl`)
      // Not written yet, and nowhere else: as reported.
      await expect(transcripts.locate(reported, id, null)).resolves.toBe(reported)
      // A compressed one can't be followed, so it isn't taken.
      writeFileSync(join(folder("sessions", "2026", "11", "07"), `rollout-y-${id}.jsonl.zst`), "")
      await expect(transcripts.locate(reported, id, null)).resolves.toBe(reported)
      const archived = join(folder("archived_sessions"), `rollout-y-${id}.jsonl`)
      writeFileSync(archived, "")
      await expect(transcripts.locate(reported, id, null)).resolves.toBe(archived)
    } finally {
      rmSync(home, { recursive: true, force: true })
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

describe("Codex's context in the person's place", () => {
  const said = (text: string) =>
    transcripts.items(
      JSON.stringify({
        timestamp: "2026-11-03T12:00:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      }),
    )

  it("leaves out what a Stop hook gave back to go on with, as Claude Code's is", () => {
    expect(
      said(
        '<hook_prompt hook_run_id="stop:27:/h/hooks.json">&lt;novadeck-messages note="x"&gt;hi&lt;/novadeck-messages&gt;</hook_prompt>',
      ),
    ).toEqual([])
    expect(said("<hook_prompt>go on</hook_prompt>")).toEqual([])
  })

  it("leaves out the note of an interrupted turn, which 0.166.0 writes as the person's", () => {
    expect(
      said("<turn_aborted>\nThe previous turn was interrupted on purpose.\n</turn_aborted>"),
    ).toEqual([])
  })

  it("leaves out context whose tag carries attributes", () => {
    expect(said('<skill name="pdf">\nHow to read PDFs\n</skill>')).toEqual([])
    expect(said("<skills_instructions>x</skills_instructions>").map(({ text }) => text)).toEqual([
      "<skills_instructions>x</skills_instructions>",
    ])
  })

  it("keeps the person's words that merely mention the tag", () => {
    expect(said("What does <hook_prompt> do?").map(({ text }) => text)).toEqual([
      "What does <hook_prompt> do?",
    ])
  })
})
