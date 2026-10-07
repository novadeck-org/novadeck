import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import type { Report } from "../shell/reports.js"
import { describe, expect, it } from "../test.js"
import { replyPreview, sessionStart } from "./harness.js"
import { harnesses } from "./registry.js"

describe("a SessionStart source", () => {
  it("is a fresh start only for startup", () => {
    expect(sessionStart("startup")).toBe("startup")
  })

  it("is a switch the harness made itself for resume, clear and compact", () => {
    for (const source of ["resume", "clear", "compact"])
      expect(sessionStart(source)).toBe("native-switch")
  })

  it("only observes the conversation when there is none", () => {
    expect(sessionStart(undefined)).toBe("conversation-observed")
  })
})

describe("the start of an agent's reply", () => {
  it("is one line of plain text", () => {
    expect(
      replyPreview("## Done\n\n- Fixed **the** `spec`\n- See [the PR](https://x.test/1)"),
    ).toBe("Done Fixed the spec See the PR")
  })

  it("drops terminal escapes, control characters and reordering marks", () => {
    expect(replyPreview("\x1b[31mred\x1b[0m \x1b]0;title\x07ok\x00\u202eevil\tend")).toBe(
      "red ok evil end",
    )
    expect(replyPreview(`arabic\u061cmark`)).toBe("arabic mark")
  })

  it("is cut to the preview length with an ellipsis, never inside a character", () => {
    const long = replyPreview("word ".repeat(100))!
    expect(long.length).toBeLessThanOrEqual(120)
    expect(long.endsWith("…")).toBe(true)
    const emoji = replyPreview(`${"a".repeat(118)}😀😀`)!
    expect(emoji.length).toBeLessThanOrEqual(120)
    expect(emoji).toBe(`${"a".repeat(118)}…`)
  })

  it("is nothing for an empty reply or one that is not text", () => {
    expect(replyPreview("  \n\x1b[0m ")).toBeUndefined()
    expect(replyPreview(undefined)).toBeUndefined()
    expect(replyPreview(42)).toBeUndefined()
  })
})

type Probe = { events: { event: string; payload: Report["payload"] }[] }
const probe = (harness: string): Probe =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, harness, "fixtures", "hooks.probe.json"), "utf8"),
  ) as Probe
// A captured hook as the runner receives it.
const report = (
  agent: AgentName,
  { event, payload }: Probe["events"][number],
  fields: Partial<Report> = {},
): Report => ({
  terminalId: "t",
  token: "0".repeat(48),
  agent,
  event,
  seq: 2_000,
  instance: "42",
  env: { cursor: false },
  payload,
  ...fields,
})
const decoded = (agent: AgentName, fields: Partial<Report> = {}) =>
  probe(agent)
    .events.flatMap((each) => harnesses[agent].decode(report(agent, each, fields)))
    .filter(({ type }) => type === "session-observed")

describe("decoding captured hooks", () => {
  it("observes Claude Code's session at its start, and nothing from its subagents", () => {
    const [start] = probe("claude").events
    expect(decoded("claude")).toEqual([
      {
        type: "session-observed",
        agent: "claude",
        sessionId: start!.payload.session_id,
        evidence: "startup",
        startedAt: 2_000,
        instance: "42",
        cwd: start!.payload.cwd,
        transcript: start!.payload.transcript_path,
        atPrompt: true,
      },
    ])
  })

  it("takes Claude Code's start, /clear, resume and fork as at its prompt, never a compaction", () => {
    const [start] = probe("claude").events
    const at = (source: string) =>
      harnesses.claude
        .decode(report("claude", { ...start!, payload: { ...start!.payload, source } }))
        .some((event) => event.type === "session-observed" && event.atPrompt === true)
    expect(["startup", "clear", "resume", "fork", "compact"].filter(at)).toEqual([
      "startup",
      "clear",
      "resume",
      "fork",
    ])
    // Codex announces its session only with the first prompt: never at its prompt.
    expect(decoded("codex")).toHaveLength(1)
    expect(decoded("codex")[0]).not.toHaveProperty("atPrompt")
  })

  it("ignores Claude Code inside Cursor, and a subagent's own session start", () => {
    expect(decoded("claude", { env: { cursor: true } })).toEqual([])
    const [start] = probe("claude").events
    const subagent = { ...start!, payload: { ...start!.payload, agent_id: "a1" } }
    expect(harnesses.claude.decode(report("claude", subagent))).toEqual([])
  })

  it("observes Codex's session at its start, unless another Codex started it", () => {
    expect(decoded("codex")).toMatchObject([{ agent: "codex", evidence: "startup" }])
    expect(decoded("codex", { env: { cursor: false, codexThread: "someone-else" } })).toEqual([])
  })

  it("observes no session at a Codex /side conversation's start, which keeps no transcript", () => {
    // Codex 0.159.3's `/side` forks an ephemeral thread: its hooks say `fork` and name no
    // transcript_path (null), while the thread it forked from stays the person's.
    const [start] = probe("codex").events
    const side = {
      ...start!,
      payload: { ...start!.payload, source: "fork", transcript_path: null },
    }
    expect(harnesses.codex.decode(report("codex", side))).toEqual([])
    const fork = { ...start!, payload: { ...start!.payload, source: "fork" } }
    expect(harnesses.codex.decode(report("codex", fork))).toMatchObject([
      { type: "session-observed", evidence: "native-switch" },
    ])
  })

  it("observes a Codex session that keeps no transcript at its start, as an ephemeral root", () => {
    // `config.ephemeral` keeps no rollout, so its hooks name no transcript_path; only a
    // fork so started is a /side conversation.
    const [start] = probe("codex").events
    const ephemeral = {
      ...start!,
      payload: { ...start!.payload, source: "startup", transcript_path: null },
    }
    expect(harnesses.codex.decode(report("codex", ephemeral))).toMatchObject([
      { type: "session-observed", evidence: "startup" },
    ])
    expect(harnesses.codex.decode(report("codex", ephemeral))[0]).not.toHaveProperty("transcript")
  })

  it("observes Antigravity's conversation in every hook", () => {
    const events = decoded("agy")
    expect(events).toHaveLength(probe("agy").events.length)
    expect(events[0]).toMatchObject({
      agent: "agy",
      evidence: "conversation-observed",
      cwd: "/home/user/project",
    })
  })
})

const shimmed = (platform: NodeJS.Platform) =>
  Object.values(harnesses)
    .filter((harness) => (harness.shims?.(platform) ?? []).length > 0)
    .map(({ id }) => id)

describe("the harness registry", () => {
  it("resumes each harness's session by its own command", () => {
    expect(harnesses.claude.resume?.("s")).toEqual(["claude", "--resume", "s"])
    expect(harnesses.codex.resume?.("s")).toEqual(["codex", "resume", "s"])
    expect(harnesses.agy.resume?.("s")).toEqual(["agy", "--conversation", "s"])
  })

  it("gives Codex a shim everywhere, and Claude Code one outside Windows", () => {
    expect(shimmed("linux")).toEqual(["claude", "codex"])
    expect(shimmed("win32")).toEqual(["codex"])
  })
})

// A PermissionRequest for `ls` from the root agent, with the directory its hook named.
const permissionReport = (agent: "claude" | "codex", cwd: unknown): Report =>
  ({
    agent,
    event: "PermissionRequest",
    seq: 1,
    instance: null,
    env: {},
    payload: {
      session_id: "00000000-0000-4000-8000-000000000001",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      cwd,
    },
  }) as unknown as Report

describe("a request's directory", () => {
  it("is the absolute one its hook names, for Claude Code and Codex alike", () => {
    for (const agent of ["claude", "codex"] as const) {
      const asked = harnesses[agent].decode(permissionReport(agent, "/work/project"))
      const request = asked.find((event) => event.type === "attention-requested")
      expect(request).toMatchObject({ cwd: "/work/project" })
    }
  })

  it("is left out where the hook names none, or a relative one", () => {
    for (const agent of ["claude", "codex"] as const)
      for (const cwd of [undefined, "project"]) {
        const asked = harnesses[agent].decode(permissionReport(agent, cwd))
        const request = asked.find((event) => event.type === "attention-requested")
        expect(request).toBeDefined()
        expect(request).not.toHaveProperty("cwd")
      }
  })
})
