import { resolve } from "node:path"

import type { Report } from "../shell/reports.js"
import { describe, expect, it } from "../test.js"
import { apply, started } from "./activity.js"
import type { Binding } from "./bindings.js"
import { maxPlan, planFile } from "./claude/decode.js"
import { agentDetail, planOf, rootRef } from "./detail.js"
import type { ActivityEvent, HarnessEvent } from "./events.js"
import { harnesses } from "./registry.js"

// An absolute path on this platform.
const at = (path: string) => resolve(path)

const hook = (event: string, payload: Report["payload"]): readonly HarnessEvent[] =>
  harnesses.claude.decode({
    terminalId: "t",
    token: "0".repeat(48),
    agent: "claude",
    event,
    seq: 1,
    instance: null,
    env: { cursor: false },
    payload: { session_id: "s", ...payload },
  })
const plans = (events: readonly HarnessEvent[]) =>
  events.filter((event) => event.type === "plan-observed")

describe("a Claude Code plan", () => {
  it("is the Markdown file plan mode writes in a plans folder", () => {
    const write = (file: string, mode = "plan", tool = "Write") =>
      plans(
        hook("PostToolUse", {
          tool_name: tool,
          permission_mode: mode,
          tool_input: { file_path: file, content: "# Plan" },
        }),
      )
    expect(write(at("/h/.claude/plans/brave-fox.md"))).toMatchObject([
      { actor: null, plan: { kind: "file", path: at("/h/.claude/plans/brave-fox.md") } },
    ])
    expect(write(at("/h/.claude/plans/brave-fox.md"), "plan", "Edit")).toHaveLength(1)
    expect(write(at("/h/.claude/plans/brave-fox.md"), "default")).toEqual([])
    expect(write(at("/p/docs/plan.md"))).toEqual([])
    expect(write(at("/h/.claude/plans/notes.txt"))).toEqual([])
    expect(write("plans/relative.md")).toEqual([])
  })

  it("is what ExitPlanMode presents: its file, or its text when it names none", () => {
    const present = (input: object, agent?: string) =>
      plans(
        hook("PermissionRequest", {
          tool_name: "ExitPlanMode",
          tool_input: input,
          ...(agent ? { agent_id: agent } : {}),
        }),
      )
    expect(present({ plan: "# P", planFilePath: at("/h/.claude/plans/p.md") })).toMatchObject([
      { plan: { kind: "file", path: at("/h/.claude/plans/p.md") } },
    ])
    expect(present({ plan: "# P" }, "sub")).toMatchObject([
      { actor: "sub", plan: { kind: "text", text: "# P" } },
    ])
    expect(present({ plan: "x".repeat(maxPlan + 10) })[0]).toMatchObject({
      plan: { text: "x".repeat(maxPlan) },
    })
    expect(present({})).toEqual([])
    // Claude Code names the file wherever its plans folder is set.
    expect(present({ plan: "# P", planFilePath: at("/p/docs/specs/p.md") })).toMatchObject([
      { plan: { kind: "file", path: at("/p/docs/specs/p.md") } },
    ])
  })

  it("cut short, says so, and leaves a character whole", () => {
    const present = (plan: string) =>
      plans(hook("PermissionRequest", { tool_name: "ExitPlanMode", tool_input: { plan } }))[0]
    expect(present("# P")).toMatchObject({ plan: { truncated: false } })
    const cut = present(`${"x".repeat(maxPlan - 1)}😀 more`)
    expect(cut).toMatchObject({ plan: { text: "x".repeat(maxPlan - 1), truncated: true } })
  })

  it("lives only in a plans folder, as Markdown", () => {
    expect(planFile(at("/h/.claude/plans/a.md"))).toBe(at("/h/.claude/plans/a.md"))
    expect(planFile(at("/h/.claude/a.md"))).toBeUndefined()
    expect(planFile(3)).toBeUndefined()
  })
})

// A plan an actor presented as text.
const text = (actor: string | null, words: string, startedAt: number): ActivityEvent => ({
  agent: "claude",
  sessionId: "s",
  instance: null,
  startedAt,
  type: "plan-observed",
  actor,
  plan: { kind: "text", text: words, truncated: false },
})

describe("an agent's plans", () => {
  const binding: Binding = { agent: "claude", sessionId: "s", instance: null }
  const base = { agent: "claude", sessionId: "s", instance: null } as const
  const observe = (actor: string | null, path: string, startedAt: number): ActivityEvent => ({
    ...base,
    startedAt,
    type: "plan-observed",
    actor,
    plan: { kind: "file", path },
  })

  it("keep each actor's latest, whatever order their hooks arrive in", () => {
    const activity = [
      observe(null, at("/h/plans/a.md"), 1),
      observe(null, at("/h/plans/b.md"), 3),
      observe(null, at("/h/plans/old.md"), 2),
      observe("sub", at("/h/plans/c.md"), 4),
    ].reduce((state, event) => apply(state, binding, event) ?? state, started(0))
    const detail = agentDetail("t", binding, activity, null)
    expect(detail.plans).toEqual([
      {
        ref: expect.stringMatching(/^[\w-]{16}$/),
        actor: rootRef(binding),
        source: "file",
        name: "b.md",
      },
      {
        ref: expect.stringMatching(/^[\w-]{16}$/),
        actor: expect.any(String),
        source: "file",
        name: "c.md",
      },
    ])
    expect(planOf(binding, activity, detail.plans[0]!.ref)?.source).toEqual({
      kind: "file",
      path: at("/h/plans/b.md"),
    })
    // Replaced, the earlier plan's ref names nothing.
    const first = apply(started(0), binding, observe(null, at("/h/plans/a.md"), 1))!
    const earlier = agentDetail("t", binding, first, null).plans[0]!.ref
    expect(planOf(binding, activity, earlier)).toBeUndefined()
  })

  it("give a revised plan its own ref, and keep each actor's place", () => {
    const first = apply(started(0), binding, text(null, "# One", 1))!
    const both = apply(first, binding, observe("sub", "/h/plans/c.md", 2))!
    const revised = apply(both, binding, text(null, "# Two", 3))!
    const before = agentDetail("t", binding, both, null).plans
    const after = agentDetail("t", binding, revised, null).plans
    expect(after.map(({ actor }) => actor)).toEqual(before.map(({ actor }) => actor))
    expect(after[0]?.ref).not.toBe(before[0]?.ref)
    expect(after[1]?.ref).toBe(before[1]?.ref)
  })

  it("make room for a new actor's plan by the oldest subagent's", () => {
    const full = Array.from({ length: 33 }, (_, index) =>
      observe(index === 0 ? null : `a${index}`, `/h/plans/${index}.md`, index + 1),
    ).reduce((state, event) => apply(state, binding, event) ?? state, started(0))
    const more = apply(full, binding, observe("late", "/h/plans/late.md", 50))!
    const actors = more.plans.map(({ actor }) => actor)
    expect(actors).toHaveLength(33)
    expect(actors).toContain(null)
    expect(actors).not.toContain("a1")
    expect(actors.at(-1)).toBe("late")
  })
})
