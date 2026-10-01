import type { AgentName } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import type { Binding } from "./bindings.js"
import type { HarnessEvent } from "./events.js"
import { followRoot, guessed, rootedIn, type Root } from "./roots.js"

const binding = (agent: AgentName, sessionId: string, instance: string | null = "7"): Binding => ({
  agent,
  sessionId,
  instance,
})

const fact = (bound: Binding) => ({ ...bound, startedAt: 1 })

const started = (bound: Binding): HarnessEvent => ({
  type: "turn-started",
  ...fact(bound),
  cause: "call",
})

const observed = (bound: Binding, root = false): HarnessEvent => ({
  type: "session-observed",
  ...fact(bound),
  evidence: "conversation-observed",
  ...(root && { root }),
})

const follow = (
  current: Root | null,
  bound: Binding | null,
  events: HarnessEvent[] = [],
  input: { mode?: "binding" | "status-line"; statusLine?: boolean; awaited?: string[] } = {},
) =>
  followRoot(current, bound, events, {
    mode: input.mode ?? "binding",
    statusLine: input.statusLine ?? false,
    awaited: (sessionId) => (input.awaited ?? []).includes(sessionId),
  })

describe("a terminal's root session", () => {
  it("is ready to be rung only when the report that bound it announced it at its prompt", () => {
    const bound = binding("claude", "s1")
    const announced = (sessionId: string): HarnessEvent => ({
      type: "session-observed",
      ...fact(binding("claude", sessionId)),
      evidence: "startup",
      atPrompt: true,
    })
    expect(follow(null, bound, [announced("s1")]).changes).toMatchObject([{ ready: true }])
    expect(follow(null, bound, [observed(bound)]).changes).toMatchObject([{ ready: false }])
    // Another session's announcement says nothing of this one.
    expect(follow(null, bound, [announced("s2")]).changes).toMatchObject([{ ready: false }])
  })

  it("is the bound session where the harness's hooks name only its own", () => {
    const first = follow(null, binding("claude", "s1"))
    expect(first).toEqual({
      root: { agent: "claude", sessionId: "s1", instance: "7", source: "binding" },
      changes: [{ type: "new", root: first.root, guess: false, ready: false }],
    })
    // The same session stays; another, as after /clear, is a new root.
    expect(follow(first.root, binding("claude", "s1")).changes).toEqual([])
    expect(follow(first.root, binding("claude", "s2")).changes).toMatchObject([
      { type: "new", root: { sessionId: "s2" }, guess: false },
    ])
    expect(follow(first.root, null)).toEqual({ root: null, changes: [{ type: "ended" }] })
    expect(follow(null, null)).toEqual({ root: null, changes: [] })
  })

  it("is a guess until a model call or the status line names it, where hooks name subagents too", () => {
    const options = { mode: "status-line" as const }
    const bound = follow(null, binding("agy", "c-sub"), [], options)
    expect(bound.changes).toMatchObject([{ type: "new", guess: true }])
    expect(guessed(bound.root!, "status-line")).toBe(true)
    // The binding following a subagent's conversation is no new root.
    expect(follow(bound.root, binding("agy", "c-other"), [], options).changes).toEqual([])
    // The first model call after it bound corrects the guess.
    const called = follow(
      bound.root,
      binding("agy", "c-root"),
      [started(binding("agy", "c-root"))],
      options,
    )
    expect(called).toMatchObject({
      root: { sessionId: "c-root", source: "invocation" },
      changes: [{ type: "corrected", from: "c-sub", confirmed: false }],
    })
    // A later call elsewhere corrects it only when messages wait for that conversation.
    const sub = [started(binding("agy", "c-sub"))]
    expect(follow(called.root, binding("agy", "c-sub"), sub, options).changes).toEqual([])
    expect(
      follow(called.root, binding("agy", "c-sub"), sub, { ...options, awaited: ["c-sub"] }).root,
    ).toMatchObject({ sessionId: "c-sub", source: "invocation" })
  })

  it("is what the status line names once it does, which alone names another", () => {
    const options = { mode: "status-line" as const, statusLine: true }
    const root = binding("agy", "c-root")
    const guess = follow(null, binding("agy", "c-sub"), [], { mode: "status-line" }).root
    const confirmed = follow(guess, root, [observed(root, true)], options)
    expect(confirmed).toMatchObject({
      root: { sessionId: "c-root", source: "status-line" },
      changes: [{ type: "corrected", from: "c-sub", confirmed: true }],
    })
    // Model calls no longer move it.
    const sub = binding("agy", "c-sub")
    expect(
      follow(confirmed.root, sub, [started(sub)], { mode: "status-line", awaited: ["c-sub"] })
        .changes,
    ).toEqual([])
    // A /clear: the status line names another conversation.
    const cleared = binding("agy", "c-new")
    expect(
      follow(confirmed.root, cleared, [observed(cleared, true)], options).changes,
    ).toMatchObject([
      { type: "new", root: { sessionId: "c-new", source: "status-line" }, guess: false },
    ])
  })

  it("is a new root when another process binds", () => {
    const first = follow(null, binding("codex", "s1", "1")).root
    expect(follow(first, binding("codex", "s1", "2")).changes).toMatchObject([{ type: "new" }])
    expect(follow(first, binding("claude", "s1", "1")).changes).toMatchObject([{ type: "new" }])
  })

  it("takes only its own process's events as its own", () => {
    const root: Root = { agent: "codex", sessionId: "s1", instance: "1", source: "binding" }
    expect(rootedIn(root, binding("codex", "s1", "1"))).toBe(true)
    expect(rootedIn(root, binding("codex", "s1", null))).toBe(true)
    expect(rootedIn(root, binding("codex", "s1", "2"))).toBe(false)
    expect(rootedIn(root, binding("codex", "s2", "1"))).toBe(false)
    expect(rootedIn(null, binding("codex", "s1", "1"))).toBe(false)
  })
})
