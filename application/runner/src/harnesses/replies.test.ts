import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import type { HarnessEvent } from "./events.js"
import { harnesses } from "./registry.js"
import { lastReply, withReplies } from "./replies.js"

const { transcript: steps } = JSON.parse(
  readFileSync(join(import.meta.dirname, "agy", "fixtures", "transcript.probe.json"), "utf8"),
) as { transcript: object[] }
const items = harnesses.agy.transcripts!.items

const folder = (resources: { defer: (cleanup: () => void) => void }) => {
  const path = mkdtempSync(join(tmpdir(), "novadeck-replies-"))
  resources.defer(() => rmSync(path, { recursive: true, force: true }))
  return path
}

// A user input step of Antigravity's transcript, as it wraps the person's text.
const input = (text: string, step: number) =>
  JSON.stringify({
    step_index: step,
    created_at: "2026-10-01T12:00:05Z",
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
  })

// A line of Claude Code's transcript.
const line = (type: string, content: unknown) => JSON.stringify({ type, message: { content } })

const base = { agent: "agy", sessionId: "c", instance: "7", startedAt: 1 } as const

describe("an agent's last reply in its transcript", () => {
  it("is the start of what Antigravity said last, as one line", async ({ resources }) => {
    const path = join(folder(resources), "transcript.jsonl")
    writeFileSync(path, `${steps.map((step) => JSON.stringify(step)).join("\n")}\n`)
    const reply = await lastReply(path, items)
    expect(reply).toMatch(/^The implementation is complete\. Created README\.md with hello\./)
    expect(reply!.length).toBeLessThanOrEqual(120)
  })

  it("is nothing once the person prompted again and the agent said nothing since", async ({
    resources,
  }) => {
    const path = join(folder(resources), "transcript.jsonl")
    writeFileSync(path, `${steps.map((step) => JSON.stringify(step)).join("\n")}\n`)
    appendFileSync(path, `${input("And now?", 12)}\n`)
    await expect(lastReply(path, items)).resolves.toBeUndefined()
  })

  it("is only what Claude Code said after its last tool step, so nothing until its final words", async ({
    resources,
  }) => {
    const claude = harnesses.claude.transcripts!.items
    const path = join(folder(resources), "transcript.jsonl")
    writeFileSync(
      path,
      [
        line("user", "Look around"),
        line("assistant", [
          { type: "text", text: "Looking first." },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ]),
        line("user", [{ type: "tool_result", tool_use_id: "t1", content: "README.md" }]),
      ].join("\n") + "\n",
    )
    await expect(lastReply(path, claude)).resolves.toBeUndefined()
    appendFileSync(path, `${line("assistant", [{ type: "text", text: "Found only a README." }])}\n`)
    await expect(lastReply(path, claude)).resolves.toBe("Found only a README.")
  })

  it("is nothing when the transcript can't be read", async () => {
    await expect(lastReply("/nonexistent/novadeck/transcript.jsonl", items)).resolves.toBe(
      undefined,
    )
  })
})

// A transcript that records "Done." as the agent's last reply.
const read = (path: string) => Promise.resolve(path === "/t/transcript.jsonl" ? "Done." : "")

describe("a turn's end its hook named no reply for", () => {
  const observed: HarnessEvent = {
    type: "session-observed",
    ...base,
    evidence: "conversation-observed",
    transcript: "/t/transcript.jsonl",
  }
  const ended: HarnessEvent = { type: "turn-ended", ...base, outcome: "completed" }

  it("takes the reply from the transcript the same report names", async () => {
    expect(await withReplies([observed, ended], items, undefined, read)).toEqual([
      observed,
      { ...ended, reply: "Done." },
    ])
  })

  it("looks again, briefly, for a reply written just after the hook started", async () => {
    let reads = 0
    const late = () => Promise.resolve((reads += 1) < 3 ? undefined : "Late.")
    expect(await withReplies([observed, ended], items, undefined, late, { gapMs: 0 })).toEqual([
      observed,
      { ...ended, reply: "Late." },
    ])
    reads = -10
    expect(await withReplies([observed, ended], items, undefined, late, { gapMs: 0 })).toEqual([
      observed,
      ended,
    ])
    expect(reads).toBe(-6)
  })

  it("reads nothing for an end that has a reply, an interrupt, a record, or no transcript", async () => {
    let reads = 0
    const counted = () => {
      reads += 1
      return Promise.resolve("Done.")
    }
    const told = { ...ended, reply: "Said." }
    const interrupted = { ...ended, outcome: "interrupted" } as const
    const recorded = { ...ended, recorded: true } as const
    expect(await withReplies([observed, told], items, undefined, counted)).toEqual([observed, told])
    expect(await withReplies([observed, interrupted], items, undefined, counted)).toEqual([
      observed,
      interrupted,
    ])
    expect(await withReplies([observed, recorded], items, undefined, counted)).toEqual([
      observed,
      recorded,
    ])
    expect(await withReplies([ended], items, undefined, counted)).toEqual([ended])
    expect(await withReplies([observed, ended], undefined, undefined, counted)).toEqual([
      observed,
      ended,
    ])
    expect(reads).toBe(0)
  })
})

// A Claude Code transcript: the person's prompt, a tool's call and result, the reply.
const claudeRecords = [
  { type: "user", timestamp: "2026-10-04T10:00:00Z", message: { content: "Fix the spec" } },
  {
    type: "assistant",
    timestamp: "2026-10-04T10:00:01Z",
    message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
  },
  {
    type: "user",
    timestamp: "2026-10-04T10:00:02Z",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
  },
  {
    type: "assistant",
    timestamp: "2026-10-04T10:00:03Z",
    message: { content: [{ type: "text", text: "**Fixed** the spec; all green." }] },
  },
]

// A Codex rollout: the context Codex adds, the person's prompt, a tool call, the reply.
const message = (role: string, type: string, text: string) => ({
  type: "response_item",
  timestamp: "2026-10-04T10:00:00Z",
  payload: { type: "message", role, content: [{ type, text }] },
})
const codexRecords = [
  message("user", "input_text", "<environment_context>cwd</environment_context>"),
  message("user", "input_text", "Fix the spec"),
  {
    type: "response_item",
    timestamp: "2026-10-04T10:00:01Z",
    payload: { type: "function_call", name: "shell", arguments: "{}", call_id: "c1" },
  },
  message("assistant", "output_text", "Fixed the spec; all green."),
  { type: "event_msg", timestamp: "2026-10-04T10:00:02Z", payload: { type: "token_count" } },
]

describe("a Stop of Claude Code or Codex that names no reply", () => {
  for (const [agent, records] of [
    ["claude", claudeRecords],
    ["codex", codexRecords],
  ] as const)
    it(`takes ${agent}'s from the bound session's own transcript`, async ({ resources }) => {
      const path = join(folder(resources), "session.jsonl")
      writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)
      const stop: HarnessEvent = { type: "turn-ended", ...base, agent, outcome: "completed" }
      const told = await withReplies([stop], harnesses[agent].transcripts!.items, {
        sessionId: "c",
        transcript: path,
      })
      expect(told).toEqual([{ ...stop, reply: "Fixed the spec; all green." }])
      // Another session's Stop reads nothing of this one's.
      const other = { ...stop, sessionId: "d" }
      const bound = { sessionId: "c", transcript: path }
      expect(await withReplies([other], harnesses[agent].transcripts!.items, bound)).toEqual([
        other,
      ])
    })
})
