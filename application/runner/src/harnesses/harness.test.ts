import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import type { Report } from "../shell/reports.js"
import { describe, expect, it } from "../test.js"
import { sessionStart } from "./harness.js"
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
