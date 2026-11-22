import type { HarnessEvent } from "@novadeck/harness-core/events"
import type { Report } from "@novadeck/harness-core/report"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { hookReport } from "@novadeck/harness-core/testing/reports"
import { describe, expect, it } from "vitest"

import { decode } from "./decode.js"

type Payload = Report["payload"]
type Probe = { readonly reports: readonly { event: string; payload: Payload }[] }
const session = loadProbe(import.meta.dirname, "session.probe.json") as Probe
const edges = loadProbe(import.meta.dirname, "edges.probe.json") as Probe

const reportsOf = (probe: Probe, event: string) =>
  probe.reports.filter((report) => report.event === event).map(({ payload }) => payload)
const decoded = (event: string, payload: Payload, seq = 5): readonly HarnessEvent[] =>
  decode(hookReport("opencode", event, payload, { seq }))
const factsOf = (probe: Probe): readonly HarnessEvent[] =>
  probe.reports.flatMap(({ event, payload }, at) => decoded(event, payload, at + 1))

const root = reportsOf(session, "SessionStart")[0]!.session_id as string
const cwd = "/home/person/project"

describe("opencode's reports, as Novadeck's plugin made them (probed 2026-11-22, 1.19.6)", () => {
  it("binds the root session at its first prompt, with its transcript and folder", () => {
    expect(decoded("SessionStart", reportsOf(session, "SessionStart")[0]!)).toEqual([
      expect.objectContaining({
        type: "session-observed",
        agent: "opencode",
        sessionId: root,
        evidence: "startup",
        atPrompt: true,
        cwd,
        transcript: `/home/person/.config/novadeck/shell/plugins/opencode/sessions/${root}.jsonl`,
      }),
    ])
  })

  it("starts a turn with each prompt the person gave, without the deliveries the plugin added", () => {
    const starts = factsOf(session).filter((fact) => fact.type === "turn-started")
    expect(starts.map((fact) => fact.type === "turn-started" && fact.prompt)).toEqual([
      "PING please",
      "BASH it",
      "QUESTION now",
      "SUBAGENT go",
    ])
  })

  it("leaves the turn a Stop's delivery starts to the runner, which continued it as it leased", () => {
    const continuation = reportsOf(session, "UserPromptSubmit").find(
      (payload) => payload.continuation === true,
    )
    expect(decoded("UserPromptSubmit", continuation!)).toEqual([])
    expect(decoded("Continued", { session_id: root })).toEqual([])
    expect(decoded("Lapsed", { session_id: root })).toEqual([
      expect.objectContaining({ type: "turn-lapsed", sessionId: root }),
    ])
  })

  it("ends each turn completed with its reply, with the model and how full its context is", () => {
    const [first] = reportsOf(session, "Stop")
    expect(decoded("Stop", first!)).toEqual([
      expect.objectContaining({ type: "turn-ended", outcome: "completed", reply: "OK." }),
      expect.objectContaining({
        type: "telemetry-observed",
        model: "fake/fake-sonnet",
        effort: null,
        context: { occupied: expect.any(Number), capacity: 200000 },
      }),
    ])
  })

  it("asks the person with the permission's own id, and its reply resolves that request", () => {
    const [asked] = reportsOf(session, "PermissionRequest")
    const [replied] = reportsOf(session, "PermissionReplied")
    const [request] = decoded("PermissionRequest", asked!)
    expect(request).toEqual(
      expect.objectContaining({
        type: "attention-requested",
        requestId: asked!.request_id,
        actor: null,
        toolName: "bash",
        kind: "permission",
        subject: "echo approved",
        choices: ["Allow once", "Allow always", "Reject"],
        input: {
          patterns: ["echo approved"],
          metadata: { command: "echo approved" },
          always: ["echo *"],
        },
        cwd,
      }),
    )
    expect(decoded("PermissionReplied", replied!)).toEqual([
      expect.objectContaining({
        type: "attention-resolved",
        requestId: asked!.request_id,
        outcome: "allowed",
        loose: false,
      }),
    ])
    expect(decoded("PermissionReplied", { ...replied!, reply: "reject" })).toEqual([
      expect.objectContaining({ type: "attention-resolved", outcome: "settled" }),
    ])
  })

  it("asks a question with its text and options, settled by its reply", () => {
    const [asked] = reportsOf(session, "QuestionRequest")
    expect(decoded("QuestionRequest", asked!)).toEqual([
      expect.objectContaining({
        type: "attention-requested",
        requestId: asked!.request_id,
        kind: "question",
        toolName: "question",
        subject: "Which colour?",
        choices: ["Red", "Blue"],
      }),
    ])
    const [replied] = reportsOf(session, "QuestionReplied")
    expect(decoded("QuestionReplied", replied!)).toEqual([
      expect.objectContaining({
        type: "attention-resolved",
        requestId: asked!.request_id,
        outcome: "allowed",
      }),
    ])
  })

  it("tells a task's child session as a subagent of the root, by its type", () => {
    const [started] = reportsOf(session, "SubagentStart")
    const [stopped] = reportsOf(session, "SubagentStop")
    expect(decoded("SubagentStart", started!)).toEqual([
      expect.objectContaining({
        type: "subagent-started",
        sessionId: root,
        actor: started!.agent_id,
        actorType: "general",
      }),
    ])
    expect(decoded("SubagentStop", stopped!)).toEqual([
      expect.objectContaining({
        type: "subagent-stopped",
        sessionId: root,
        actor: started!.agent_id,
      }),
    ])
  })

  it("tells each tool call with what it counts as, Novadeck's own by its server's prefix", () => {
    const calls = factsOf(session).flatMap((fact) =>
      fact.type === "tool-called" ? [[fact.toolName, fact.kind]] : [],
    )
    expect(calls).toEqual([
      ["novadeck_ping", "novadeck"],
      ["bash", "work"],
      ["question", "work"],
      ["task", "work"],
    ])
  })

  it("names a subagent's own request as its actor's, under the root's session", () => {
    const [asked] = reportsOf(session, "PermissionRequest")
    const [request] = decoded("PermissionRequest", {
      ...asked!,
      session_id: "ses_child00000001",
      root,
    })
    expect(request).toEqual(
      expect.objectContaining({ sessionId: root, actor: "ses_child00000001" }),
    )
  })
})

describe("how a turn ended, as its Stop says (probed 2026-11-22, 1.19.6)", () => {
  const stops = reportsOf(edges, "Stop")

  it("is interrupted after the person's Escape, which opencode records as an aborted message", () => {
    expect(decoded("Stop", stops[0]!)[0]).toEqual(
      expect.objectContaining({ type: "turn-ended", outcome: "interrupted" }),
    )
  })

  it("is failed with the API's error where the model call was refused", () => {
    expect(decoded("Stop", stops[2]!)[0]).toEqual(
      expect.objectContaining({
        type: "turn-ended",
        outcome: "failed",
        error: "fake model refuses this one",
      }),
    )
    expect(decoded("Stop", stops[2]!)[0]).not.toHaveProperty("limited")
  })

  it("is failed on a usage limit where opencode's message says one ran out", () => {
    const limited = {
      ...stops[2]!,
      error: { name: "APIError", message: "Free usage limit reached. Try again later." },
    }
    expect(decoded("Stop", limited)[0]).toEqual(
      expect.objectContaining({ outcome: "failed", limited: true }),
    )
  })

  it("is interrupted where the person rejected a permission, which ends the turn with no error", () => {
    expect(decoded("Stop", { ...stops[1]!, rejected: true })[0]).toEqual(
      expect.objectContaining({ type: "turn-ended", outcome: "interrupted" }),
    )
  })

  it("is completed with the reply otherwise", () => {
    expect(decoded("Stop", stops[1]!)[0]).toEqual(
      expect.objectContaining({ outcome: "completed", reply: "slow done" }),
    )
  })
})

describe("a session the plugin binds otherwise", () => {
  it("reports its interface's going home as the session it left, which ends there", () => {
    const [fact] = decoded("SessionLeft", { session_id: root })
    expect(fact).toMatchObject({ type: "session-left", sessionId: root })
  })

  it("resumed is a switch it announced, at its prompt as Claude Code's resume is", () => {
    const [fact] = decoded("SessionStart", { session_id: root, source: "resume", cwd })
    expect(fact).toEqual(expect.objectContaining({ evidence: "native-switch" }))
    expect(fact).toHaveProperty("atPrompt", true)
  })

  it("compacted says so", () => {
    expect(decoded("SessionStart", { session_id: root, source: "compact" })[0]).toEqual(
      expect.objectContaining({ evidence: "native-switch", compacted: true }),
    )
  })

  it("in its plan agent plans", () => {
    const told = decoded("UserPromptSubmit", {
      session_id: root,
      prompt: "make a plan",
      agent: "plan",
    })
    expect(told).toContainEqual(expect.objectContaining({ type: "mode-observed", planning: true }))
  })

  it("names no session, so tells nothing", () => {
    expect(decoded("Stop", { error: null })).toEqual([])
  })
})

describe("a plan", () => {
  it("is what its plan agent answered, by default", () => {
    const told = decoded("Stop", {
      session_id: root,
      agent: "plan",
      plan: "1. Read\n2. Write",
      last_assistant_message: "1. Read",
    })
    expect(told).toContainEqual(
      expect.objectContaining({
        type: "plan-observed",
        actor: null,
        plan: { kind: "text", text: "1. Read\n2. Write", truncated: false },
      }),
    )
    expect(decoded("Stop", { session_id: root, agent: "build", plan: null })).not.toContainEqual(
      expect.objectContaining({ type: "plan-observed" }),
    )
  })

  it("asked about with plan_exit, in its experimental plan mode, is a review of the file it names", () => {
    const told = decoded("QuestionRequest", {
      session_id: root,
      request_id: "que_1",
      tool_name: "plan_exit",
      cwd,
      questions: [
        {
          question:
            "Plan at .opencode/plans/1-calm-fox.md is complete. Would you like to switch to the build agent and start implementing?",
          header: "Build Agent",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    })
    expect(told).toEqual([
      expect.objectContaining({
        type: "attention-requested",
        kind: "plan",
        toolName: "plan_exit",
        choices: ["Yes", "No"],
      }),
      expect.objectContaining({
        type: "plan-observed",
        plan: { kind: "file", path: "/home/person/project/.opencode/plans/1-calm-fox.md" },
      }),
    ])
  })

  it("outside a git repository names its file from the root, as opencode words it", () => {
    const [, plan] = decoded("QuestionRequest", {
      session_id: root,
      request_id: "que_2",
      tool_name: "plan_exit",
      cwd,
      worktree: "/",
      questions: [
        {
          question:
            "Plan at home/person/.local/share/opencode/plans/1-x.md is complete. Would you like to switch to the build agent and start implementing?",
          options: [],
        },
      ],
    })
    expect(plan).toEqual(
      expect.objectContaining({
        plan: { kind: "file", path: "/home/person/.local/share/opencode/plans/1-x.md" },
      }),
    )
  })
})
