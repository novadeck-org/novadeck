import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import type { Report } from "../shell/reports.js"
import { describe, expect, it } from "../test.js"
import { apply, started, subagentRef, summary, type Activity } from "./activity.js"
import type { Binding } from "./bindings.js"
import type { ActivityEvent } from "./events.js"
import { harnesses } from "./registry.js"

type Scenario = { events: { event: string; payload: Report["payload"] }[] }
const scenario = (agent: AgentName, name: string): Scenario =>
  (
    JSON.parse(
      readFileSync(join(import.meta.dirname, agent, "fixtures", "interactive.probe.json"), "utf8"),
    ) as { scenarios: { [name: string]: Scenario } }
  ).scenarios[name]!

/**
 * A captured scenario's activity as the runner would track it: each hook decoded in order,
 * the first session it names bound, and every later fact applied to that binding.
 */
const replay = (agent: AgentName, name: string) => {
  let binding: Binding | undefined
  let activity: Activity | undefined
  const states: ReturnType<typeof summary>[] = []
  scenario(agent, name).events.forEach(({ event, payload }, index) => {
    const report: Report = {
      terminalId: "t",
      token: "0".repeat(48),
      agent,
      event,
      seq: index,
      instance: null,
      env: { cursor: false },
      payload,
    }
    for (const fact of harnesses[agent].decode(report)) {
      if (fact.type === "session-observed") {
        if (!binding) {
          binding = { agent, sessionId: fact.sessionId, instance: null }
          activity = started(fact.startedAt, harnesses[agent].wakes)
        }
        continue
      }
      if (fact.type === "telemetry-observed") continue
      const next = binding && activity && apply(activity, binding, fact)
      if (next) states.push(summary((activity = next)))
    }
  })
  return { states, last: activity && summary(activity) }
}

// Idle once its turn ended as `lastTurn` says, whenever it ended.
const idle = (lastTurn: Omit<NonNullable<ReturnType<typeof summary>["lastTurn"]>, "at">) => ({
  state: "idle",
  attention: { pending: 0, kind: null },
  subagents: [],
  planning: false,
  background: null,
  lastTurn: { ...lastTurn, at: expect.any(Number) },
})

// What a turn running shows: no end yet.
const ongoing = { lastTurn: null }

// A completed turn, its reply as the captured hook named it.
const replied = { outcome: "completed", reply: "<text>" } as const

describe("activity from captured hooks", () => {
  it("waits on the person while Claude Code asks, and works again once allowed", () => {
    const { states, last } = replay("claude", "allow")
    expect(states).toContainEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
      subagents: [],
      planning: false,
      background: null,
      ...ongoing,
    })
    expect(last).toEqual(idle(replied))
  })

  it("asks a question through Claude Code's AskUserQuestion, and settles on the answer", () => {
    const { states, last } = replay("claude", "question")
    expect(states).toContainEqual({
      state: "working",
      attention: { pending: 1, kind: "question" },
      subagents: [],
      planning: false,
      background: null,
      ...ongoing,
    })
    expect(last).toEqual(idle(replied))
  })

  it("keeps a denied Claude Code request waiting, as nothing reports the denial", () => {
    expect(replay("claude", "deny").last).toEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
      subagents: [],
      planning: false,
      background: null,
      ...ongoing,
    })
  })

  it("ends a Codex turn on Interrupt, settling the request it denied", () => {
    const { states, last } = replay("codex", "deny-then-interrupt")
    expect(states).toContainEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
      subagents: [],
      planning: false,
      background: null,
      ...ongoing,
    })
    expect(last).toEqual(idle({ outcome: "interrupted", reply: null }))
  })

  it("settles an approved Codex request, whose result no longer describes the call", () => {
    const { states, last } = replay("codex", "approve")
    expect(states).toContainEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
      subagents: [],
      planning: false,
      background: null,
      ...ongoing,
    })
    expect(states).toContainEqual({
      state: "working",
      attention: { pending: 0, kind: null },
      subagents: [],
      planning: false,
      background: null,
      ...ongoing,
    })
    expect(last).toEqual(idle(replied))
  })

  it("plans in Claude Code's plan mode, and waits on the person to review the plan", () => {
    const { last } = replay("claude", "plan")
    expect(last).toMatchObject({ planning: true, attention: { pending: 1, kind: "plan" } })
  })

  it("works through Antigravity's model calls and idles at Stop", () => {
    const { states } = replay("agy", "clear")
    expect(states[0]).toEqual({
      state: "working",
      attention: { pending: 0, kind: null },
      subagents: [],
      planning: false,
      background: null,
      ...ongoing,
    })
    // Its Stop names no reply; its transcript does, which the runner reads apart.
    expect(states).toContainEqual(idle({ outcome: "completed", reply: null }))
  })
})

const fact = (fields: Partial<ActivityEvent> & Pick<ActivityEvent, "type">) =>
  ({ agent: "claude", sessionId: "s", instance: "7", startedAt: 5, ...fields }) as ActivityEvent

/** The ids of the requests waiting. */
const ids = (activity: Activity) => activity.pending.map(({ requestId }) => requestId)

describe("applying activity", () => {
  const binding: Binding = { agent: "claude", sessionId: "s", instance: "7" }

  it("ignores another session's facts, and another process's", () => {
    expect(
      apply(started(0), binding, fact({ type: "turn-started", sessionId: "t" })),
    ).toBeUndefined()
    expect(
      apply(started(0), binding, fact({ type: "turn-started", instance: "8" })),
    ).toBeUndefined()
  })

  it("ignores a fact from a hook that started before the latest applied", () => {
    const working = apply(started(0), binding, fact({ type: "turn-started", startedAt: 10 }))!
    expect(
      apply(working, binding, fact({ type: "turn-ended", outcome: "completed", startedAt: 9 })),
    ).toBeUndefined()
  })

  const request = (requestId: string, actor: string | null, startedAt = 5) =>
    fact({
      type: "attention-requested",
      requestId,
      actor,
      toolName: "Bash",
      kind: "permission",
      startedAt,
    })
  // A result's hook starts after its request's, which these ask by 8.
  const result = (requestId: string, actor: string | null, toolName = "Bash", loose = false) =>
    fact({
      type: "attention-resolved",
      requestId,
      actor,
      toolName,
      loose,
      outcome: "allowed",
      startedAt: 9,
    })

  it("keeps one actor's request waiting while another actor's calls finish", () => {
    const waiting = apply(started(0), binding, request("a:Bash:1", "a"))!
    // Another subagent's own call of the same tool, which needed no permission.
    expect(apply(waiting, binding, result("b:Bash:2", "b"))).toBeUndefined()
    expect(apply(waiting, binding, result("a:Bash:1", "a"))?.pending).toEqual([])
  })

  it("keeps requests of one turn whatever order their hooks arrive in", () => {
    const later = apply(started(0), binding, request("b", null, 7))!
    const both = apply(later, binding, request("a", null, 6))!
    expect(summary(both).attention.pending).toBe(2)
  })

  it("drops a request from a turn already over", () => {
    const over = apply(
      started(0),
      binding,
      fact({ type: "turn-ended", outcome: "completed", startedAt: 10 }),
    )!
    expect(apply(over, binding, request("a", null, 9))).toBeUndefined()
  })

  it("settles the root's own requests when its turn ends, as a faked Stop would too", () => {
    const working = apply(started(0), binding, fact({ type: "turn-started", startedAt: 1 }))!
    const waiting = apply(working, binding, request("a", null, 5))!
    const ended = apply(
      waiting,
      binding,
      fact({ type: "turn-ended", outcome: "completed", startedAt: 10 }),
    )!
    expect(ended.pending).toEqual([])
    expect(summary(ended).attention).toEqual({ pending: 0, kind: null })
  })

  it("settles a question loosely by its actor and tool, as its answered call changed", () => {
    const asked = apply(
      started(0),
      binding,
      fact({
        type: "attention-requested",
        requestId: "q1",
        actor: null,
        toolName: "AskUserQuestion",
        kind: "question",
      }),
    )!
    expect(apply(asked, binding, result("q2", "sub", "AskUserQuestion", true))).toBeUndefined()
    expect(apply(asked, binding, result("q2", null, "AskUserQuestion", true))?.pending).toEqual([])
  })

  const subagent = (type: "subagent-started" | "subagent-stopped", actor: string, startedAt = 5) =>
    fact(
      type === "subagent-started"
        ? { type, actor, actorType: "explorer", startedAt }
        : { type, actor, startedAt },
    )

  it("tracks subagents across turns, as a background one outlives the turn that began it", () => {
    const running = apply(started(0), binding, subagent("subagent-started", "a"))!
    expect(apply(running, binding, subagent("subagent-started", "a"))).toBeUndefined()
    const next = apply(
      apply(running, binding, fact({ type: "turn-ended", outcome: "completed", startedAt: 8 }))!,
      binding,
      fact({ type: "turn-started", startedAt: 9 }),
    )!
    expect(summary(next).subagents).toEqual([{ id: subagentRef("a"), type: "explorer" }])
    // Its stop's hook started before the turn did; subagents answer to no turn.
    expect(summary(apply(next, binding, subagent("subagent-stopped", "a", 7))!).subagents).toEqual(
      [],
    )
  })

  // A background subagent from before the turn, and the root, each asking.
  const asking = () => {
    const background = apply(started(0), binding, subagent("subagent-started", "bg", 3))!
    const turn = apply(background, binding, fact({ type: "turn-started", startedAt: 4 }))!
    return apply(
      apply(turn, binding, request("bg:Bash:1", "bg", 6))!,
      binding,
      request("root:Bash:1", null, 7),
    )!
  }

  it("keeps a background subagent's request past the root's turn start, end, idle and escape", () => {
    for (const boundary of [
      fact({ type: "turn-started", startedAt: 10 }),
      fact({ type: "turn-ended", outcome: "completed", startedAt: 10 }),
      fact({ type: "turn-idle", startedAt: 10 }),
      fact({ type: "turn-escaped", startedAt: 10 }),
    ]) {
      const next = apply(asking(), binding, boundary)!
      expect(ids(next), boundary.type).toEqual(["bg:Bash:1"])
      expect(summary(next).attention, boundary.type).toEqual({ pending: 1, kind: "permission" })
    }
  })

  it("settles a background subagent's request at its own resolution or stop", () => {
    const ended = apply(
      asking(),
      binding,
      fact({ type: "turn-ended", outcome: "completed", startedAt: 10 }),
    )!
    expect(apply(ended, binding, result("bg:Bash:1", "bg"))?.pending).toEqual([])
    expect(apply(ended, binding, subagent("subagent-stopped", "bg", 12))?.pending).toEqual([])
  })

  it("settles the requests of the subagents an interrupted turn ended, and of none running", () => {
    const running = apply(asking(), binding, subagent("subagent-started", "fg", 5))!
    const both = apply(
      apply(running, binding, request("fg:Bash:1", "fg", 8))!,
      binding,
      // A subagent never seen starting, or already stopped: nothing else would settle it.
      request("gone:Bash:1", "gone", 8),
    )!
    const stopped = apply(
      both,
      binding,
      fact({ type: "turn-ended", outcome: "interrupted", startedAt: 10 }),
    )!
    expect(ids(stopped)).toEqual(["bg:Bash:1"])
  })

  it("ignores a stop for a subagent never seen starting, as internal agents send", () => {
    expect(
      summary(apply(started(0), binding, subagent("subagent-stopped", "x"))!).subagents,
    ).toEqual([])
  })

  it("ends the subagents an interrupted turn started, and keeps a background one", () => {
    const background = apply(started(0), binding, subagent("subagent-started", "bg", 3))!
    const turn = apply(background, binding, fact({ type: "turn-started", startedAt: 10 }))!
    const running = apply(turn, binding, subagent("subagent-started", "fg", 12))!
    const stopped = apply(
      running,
      binding,
      fact({ type: "turn-ended", outcome: "interrupted", startedAt: 20 }),
    )!
    expect(summary(stopped).subagents).toEqual([{ id: subagentRef("bg"), type: "explorer" }])
    // Its start's hook began before the interrupt, but its report came after.
    expect(apply(stopped, binding, subagent("subagent-started", "late", 15))).toBeUndefined()
    expect(apply(stopped, binding, subagent("subagent-started", "fg", 12))).toBeUndefined()
    expect(apply(stopped, binding, subagent("subagent-started", "next", 25))).toBeDefined()
  })

  it("keeps a subagent out whose stop arrived before its start", () => {
    const gone = apply(started(0), binding, subagent("subagent-stopped", "a", 12))!
    expect(summary(gone).subagents).toEqual([])
    expect(apply(gone, binding, subagent("subagent-started", "a", 11))).toBeUndefined()
  })

  it("counts a resumed subagent again, under the id it kept", () => {
    const first = apply(started(0), binding, subagent("subagent-started", "r", 11))!
    const done = apply(first, binding, subagent("subagent-stopped", "r", 20))!
    const resumed = apply(done, binding, subagent("subagent-started", "r", 31))!
    expect(summary(resumed).subagents).toEqual([{ id: subagentRef("r"), type: "explorer" }])
    expect(
      summary(apply(resumed, binding, subagent("subagent-stopped", "r", 40))!).subagents,
    ).toEqual([])
    // The first run's stop, arriving again, changes nothing.
    expect(apply(done, binding, subagent("subagent-stopped", "r", 20))).toBeUndefined()
  })

  it("keeps a late start out after a turn is interrupted twice", () => {
    const turn = apply(started(0), binding, fact({ type: "turn-started", startedAt: 10 }))!
    const once = apply(
      turn,
      binding,
      fact({ type: "turn-ended", outcome: "interrupted", startedAt: 25 }),
    )!
    const twice = apply(
      once,
      binding,
      fact({ type: "turn-ended", outcome: "interrupted", startedAt: 26 }),
    )!
    expect(apply(twice, binding, subagent("subagent-started", "late", 20))).toBeUndefined()
  })

  it("keeps one plan per actor waiting, and settles it though edited in review", () => {
    const plan = (requestId: string, startedAt: number) =>
      fact({
        type: "attention-requested",
        requestId,
        actor: null,
        toolName: "ExitPlanMode",
        kind: "plan",
        startedAt,
      })
    const revised = apply(apply(started(0), binding, plan("p1", 5))!, binding, plan("p2", 6))!
    expect(summary(revised).attention).toEqual({ pending: 1, kind: "plan" })
    const approved = apply(revised, binding, result("p3", null, "ExitPlanMode", true))!
    expect(summary(approved).attention).toEqual({ pending: 0, kind: null })
  })

  it("plans as the latest hook to name the mode said, whatever order they arrive in", () => {
    const mode = (planning: boolean, startedAt: number) =>
      fact({ type: "mode-observed", planning, startedAt })
    const planning = apply(started(0), binding, mode(true, 10))!
    expect(summary(planning).planning).toBe(true)
    expect(apply(planning, binding, mode(false, 9))).toBeUndefined()
    expect(summary(apply(planning, binding, mode(false, 11))!).planning).toBe(false)
  })

  it("carries no id or kind longer than the protocol takes", () => {
    const long = "x".repeat(300)
    expect(apply(started(0), binding, subagent("subagent-started", long))).toBeUndefined()
    const typed = apply(
      started(0),
      binding,
      fact({ type: "subagent-started", actor: "a", actorType: long }),
    )!
    expect(summary(typed).subagents[0]?.type).toHaveLength(256)
  })

  it("keeps a subagent's request when it asks again, as its parallel calls show dialogs together", () => {
    const ended = apply(
      asking(),
      binding,
      fact({ type: "turn-ended", outcome: "completed", startedAt: 10 }),
    )!
    // Its call's result, of a call it ran alongside, or another actor's request: none
    // tells that its dialog closed.
    expect(apply(ended, binding, { ...result("bg:Read:2", "bg"), startedAt: 12 })).toBeUndefined()
    const other = apply(ended, binding, request("fg:Bash:1", "fg", 12))!
    expect(ids(other)).toEqual(["bg:Bash:1", "fg:Bash:1"])
    // Nor does its own next request: both dialogs may show.
    const again = apply(ended, binding, request("bg:Bash:2", "bg", 12))!
    expect(ids(again)).toEqual(["bg:Bash:1", "bg:Bash:2"])
    expect(summary(again).attention).toEqual({ pending: 2, kind: "permission" })
    // An older one, arriving after the newer one, waits too.
    expect(ids(apply(again, binding, request("bg:Bash:0", "bg", 8))!)).toEqual([
      "bg:Bash:1",
      "bg:Bash:2",
      "bg:Bash:0",
    ])
  })

  it("keeps a running subagent's request asked before the root's Stop, and drops the root's", () => {
    const ended = apply(
      asking(),
      binding,
      fact({ type: "turn-ended", outcome: "completed", startedAt: 10 }),
    )!
    // Hooks that started before the Stop, reported after it.
    const late = apply(ended, binding, request("bg:Edit:1", "bg", 9))!
    expect(ids(late)).toEqual(["bg:Bash:1", "bg:Edit:1"])
    expect(late.state).toBe("idle")
    expect(apply(ended, binding, request("root:Edit:1", null, 9))).toBeUndefined()
    // One never seen starting runs from its request on; one seen stopping after it asked
    // waits on the person no longer.
    expect(ids(apply(ended, binding, request("unseen:Edit:1", "unseen", 9))!)).toEqual([
      "bg:Bash:1",
      "unseen:Edit:1",
    ])
    const gone = apply(ended, binding, subagent("subagent-stopped", "gone", 9))!
    expect(apply(gone, binding, request("gone:Edit:1", "gone", 8))).toBeUndefined()
  })

  it("leaves the root idle when a background subagent asks after its Stop", () => {
    // As Codex's spawned agent asks after the root's turn ended (probed 2026-10-03, 0.159.3),
    // whose end never wakes the root.
    const ended = apply(
      { ...asking(), wakes: false },
      binding,
      fact({ type: "turn-ended", outcome: "completed", startedAt: 10 }),
    )!
    const asked = apply(ended, binding, request("bg:Bash:2", "bg", 12))!
    expect(summary(asked)).toMatchObject({ state: "idle", attention: { pending: 2 } })
    // The root's own request still says its turn runs.
    expect(apply(started(0), binding, request("root:Bash:1", null, 12))?.state).toBe("working")
  })

  it("settles a subagent's request its rollout says it aborted, and none it asked after", () => {
    // Codex fires no hook when Esc dismisses a spawned agent's request; its own rollout's
    // `turn_aborted` ends that subagent's turn, at the abort's time.
    const turn = apply(
      apply(asking(), binding, fact({ type: "turn-ended", outcome: "completed", startedAt: 10 }))!,
      binding,
      fact({ type: "turn-started", startedAt: 11 }),
    )!
    expect(ids(turn)).toEqual(["bg:Bash:1"])
    const abort = fact({ type: "subagent-turn-aborted", actor: "bg", startedAt: 12 })
    const aborted = apply(turn, binding, abort)!
    expect(ids(aborted)).toEqual([])
    // Its next turn's request, asked after the abort, waits.
    expect(ids(apply(aborted, binding, request("bg:Bash:2", "bg", 13))!)).toEqual(["bg:Bash:2"])
    // One asked after the abort, reported before it, outlives it.
    const later = apply(turn, binding, request("bg:Bash:3", "bg", 14))!
    expect(ids(apply(later, binding, abort)!)).toEqual(["bg:Bash:3"])
  })

  it("leaves a request asked again after a result whose hook started before it", () => {
    const again = apply(started(0), binding, request("a:Bash:1", "a", 10))!
    // The first time's result, its hook started before the second ask's.
    const early = fact({
      type: "attention-resolved",
      requestId: "a:Bash:1",
      actor: "a",
      toolName: "Bash",
      loose: false,
      outcome: "allowed",
      startedAt: 8,
    })
    expect(apply(again, binding, early)).toBeUndefined()
    expect(apply(again, binding, { ...early, startedAt: 11 })?.pending).toEqual([])
  })

  it("keeps at most 32 subagents", () => {
    let activity = started(0)
    for (let index = 0; index < 40; index += 1)
      activity = apply(activity, binding, subagent("subagent-started", `a${index}`)) ?? activity
    expect(activity.subagents).toHaveLength(32)
  })

  it("makes room at 32 subagents for a new one's request, the one whose turn aborted longest ago giving way", () => {
    // Codex keeps a subagent's thread open after Esc aborted its turn: it may never run
    // again, and must not crowd a live one's request out of the subagents it follows.
    let full = started(0)
    for (let index = 0; index < 32; index += 1)
      full = apply(full, binding, subagent("subagent-started", `a${index}`, 1))!
    const abort = (activity: Activity, actor: string, at: number) =>
      apply(
        apply(activity, binding, request(`${actor}:Bash:1`, actor, at))!,
        binding,
        fact({ type: "subagent-turn-aborted", actor, startedAt: at + 1 }),
      )!
    const aborted = abort(abort(full, "a7", 4), "a3", 6)
    const asked = apply(aborted, binding, request("n:Bash:1", "n", 9))!
    const running = asked.subagents.map(({ id }) => id)
    expect(running).toHaveLength(32)
    expect(running).toContain("n")
    expect(running).not.toContain("a7")
    expect(running).toContain("a3")
    // Its request, a running subagent's, outlives the root's turns.
    expect(ids(apply(asked, binding, fact({ type: "turn-started", startedAt: 10 }))!)).toEqual([
      "n:Bash:1",
    ])
    // A subagent that asked again since its abort runs: none gives way, and a start waits.
    const again = apply(abort(full, "a7", 4), binding, request("a7:Bash:2", "a7", 8))!
    expect(apply(again, binding, subagent("subagent-started", "m", 9))).toBeUndefined()
  })

  it("keeps a Codex subagent running when its rollout says its turn aborted, settling what it asked by then", () => {
    // Esc on a Codex spawned agent's request fires no hook, and its thread stays open: its
    // rollout's `turn_aborted` ends only that turn.
    const ended = apply(
      asking(),
      binding,
      fact({ type: "turn-ended", outcome: "completed", startedAt: 10 }),
    )!
    const aborted = apply(
      ended,
      binding,
      fact({ type: "subagent-turn-aborted", actor: "bg", startedAt: 12 }),
    )!
    expect(ids(aborted)).toEqual([])
    expect(summary(aborted).subagents).toEqual([{ id: subagentRef("bg"), type: "explorer" }])
    // Its next request, as a running subagent's, outlives the root's turns.
    const again = apply(aborted, binding, request("bg:Bash:2", "bg", 13))!
    const next = apply(
      apply(again, binding, fact({ type: "turn-started", startedAt: 14 }))!,
      binding,
      fact({ type: "turn-ended", outcome: "completed", startedAt: 15 }),
    )!
    expect(ids(next)).toEqual(["bg:Bash:2"])
    // An abort before it, reported after it, settles nothing.
    expect(
      apply(again, binding, fact({ type: "subagent-turn-aborted", actor: "bg", startedAt: 12 })),
    ).toBeUndefined()
  })

  it("keeps each of a subagent's requests raised alongside until its own result", () => {
    // Parallel calls raise their dialogs together; hooks report in any order.
    const ended = apply(
      asking(),
      binding,
      fact({ type: "turn-ended", outcome: "completed", startedAt: 10 }),
    )!
    const b = apply(ended, binding, request("bg:Bash:b", "bg", 13))!
    // A's hook started first but reports after B's.
    const both = apply(b, binding, request("bg:Bash:a", "bg", 12))!
    expect(ids(both)).toEqual(["bg:Bash:1", "bg:Bash:b", "bg:Bash:a"])
    const bDone = apply(both, binding, { ...result("bg:Bash:b", "bg"), startedAt: 14 })!
    expect(ids(bDone)).toEqual(["bg:Bash:1", "bg:Bash:a"])
    expect(summary(bDone).attention.pending).toBe(2)
  })

  it("follows a subagent it never saw start from its request on, as one started before the binding", () => {
    const turn = apply(started(0), binding, fact({ type: "turn-started", startedAt: 4 }))!
    const asked = apply(turn, binding, request("pre:Bash:1", "pre", 6))!
    expect(summary(asked).subagents).toEqual([{ id: subagentRef("pre"), type: null }])
    // The root's turn ends; the subagent's dialog may still show.
    const ended = apply(
      asked,
      binding,
      fact({ type: "turn-ended", outcome: "completed", startedAt: 10 }),
    )!
    expect(ids(ended)).toEqual(["pre:Bash:1"])
    // Asked before that Stop, reported after it, it still waits.
    expect(ids(apply(ended, binding, request("pre2:Bash:1", "pre2", 9))!)).toEqual([
      "pre:Bash:1",
      "pre2:Bash:1",
    ])
    // Its stop settles it, as a running subagent's.
    expect(ids(apply(ended, binding, subagent("subagent-stopped", "pre", 12))!)).toEqual([])
  })
})

const interrupt = (payload: Report["payload"]): Report => ({
  terminalId: "t",
  token: "0".repeat(48),
  agent: "codex",
  event: "Interrupt",
  seq: 1,
  instance: null,
  env: { cursor: false },
  payload,
})

describe("an agent's mode", () => {
  it("comes from the root agent's hooks, not a subagent's", () => {
    const hook = (payload: Report["payload"]) =>
      harnesses.claude.decode({ ...interrupt(payload), agent: "claude", event: "UserPromptSubmit" })
    expect(hook({ session_id: "s", permission_mode: "plan" })).toContainEqual(
      expect.objectContaining({ type: "mode-observed", planning: true }),
    )
    expect(
      hook({ session_id: "s", agent_id: "a", permission_mode: "plan" }).map(({ type }) => type),
    ).not.toContain("mode-observed")
  })

  it("comes from Codex's rollout, as its hooks say default even in Plan Mode", () => {
    const hook = harnesses.codex.decode({
      ...interrupt({ session_id: "s", permission_mode: "default" }),
      event: "UserPromptSubmit",
    })
    expect(hook.map(({ type }) => type)).not.toContain("mode-observed")
  })
})

describe("a Codex subagent's interrupt", () => {
  it("ends its own work, not the turn", () => {
    expect(harnesses.codex.decode(interrupt({ session_id: "s", agent_id: "a" }))).toEqual([])
    expect(harnesses.codex.decode(interrupt({ session_id: "s" }))).toMatchObject([
      { type: "turn-ended", outcome: "interrupted" },
    ])
  })
})

type HookProbe = { events: { event: string; payload: Report["payload"] }[] }

describe("subagents from captured hooks", () => {
  for (const agent of ["claude", "codex"] as const)
    it(`start and stop under ${agent}'s root session, by their own id`, () => {
      const { events } = JSON.parse(
        readFileSync(join(import.meta.dirname, agent, "fixtures", "hooks.probe.json"), "utf8"),
      ) as HookProbe
      const facts = events.flatMap(({ event, payload }, seq) =>
        harnesses[agent]
          .decode({
            terminalId: "t",
            token: "0".repeat(48),
            agent,
            event,
            seq,
            instance: null,
            env: { cursor: false },
            payload,
          })
          .filter(({ type }) => type === "subagent-started" || type === "subagent-stopped"),
      )
      const start = events.find(({ event }) => event === "SubagentStart")!.payload
      expect(facts).toMatchObject([
        { type: "subagent-started", actor: start.agent_id, actorType: start.agent_type },
        { type: "subagent-stopped", actor: start.agent_id },
      ])
    })
})

describe("an agent waiting on what its turn left running", () => {
  const binding: Binding = { agent: "claude", sessionId: "s", instance: "7" }
  type Fields = Parameters<typeof fact>[0]
  const turn = (activity: Activity, startedAt: number, extra: object = {}) =>
    apply(activity, binding, fact({ type: "turn-started", startedAt, ...extra } as Fields))!
  const stop = (activity: Activity, startedAt: number, extra: object = {}) =>
    apply(
      activity,
      binding,
      fact({ type: "turn-ended", outcome: "completed", startedAt, ...extra } as Fields),
    )
  const subagentStarted = (activity: Activity, actor: string, startedAt: number) =>
    apply(
      activity,
      binding,
      fact({ type: "subagent-started", actor, actorType: "explorer", startedAt }),
    )!
  const none = { agents: 0, tasks: 0 }

  it("works on after a Stop that lists subagents still running, until a later turn ends with none", () => {
    const waiting = stop(turn(started(0), 1), 2, { background: { agents: 2, tasks: 1 } })!
    expect(waiting.state).toBe("idle")
    expect(summary(waiting)).toMatchObject({
      state: "working",
      background: { agents: 2, tasks: 1 },
    })
    // The work's end wakes it: its own turn runs, and says nothing of the wait.
    const woken = turn(waiting, 3, { cause: "harness" })
    expect(summary(woken)).toMatchObject({ state: "working", background: null })
    expect(summary(stop(woken, 4, { background: { agents: 1, tasks: 0 } })!)).toMatchObject({
      state: "working",
      background: { agents: 1, tasks: 0 },
    })
    expect(summary(stop(woken, 4, { background: none })!)).toMatchObject({
      state: "idle",
      background: null,
    })
  })

  it("shows a command left running without working on, as one may run for ever", () => {
    expect(summary(stop(turn(started(0), 1), 2, { background: { agents: 0, tasks: 2 } })!)).toEqual(
      expect.objectContaining({ state: "idle", background: { agents: 0, tasks: 2 } }),
    )
  })

  it("keeps working through a Stop Novadeck continued, until the continuation's own Stop", () => {
    const stopped = stop(turn(started(0), 1), 2, { background: none })!
    const continued = apply(stopped, binding, fact({ type: "turn-continued", startedAt: 2 }))!
    expect(summary(continued).state).toBe("working")
    // Only that Stop's: one after a later fact, or once working, changes nothing.
    expect(
      apply(continued, binding, fact({ type: "turn-continued", startedAt: 2 })),
    ).toBeUndefined()
    expect(apply(stopped, binding, fact({ type: "turn-continued", startedAt: 1 }))).toBeUndefined()
    // The record of the continued Stop, written after it, ends nothing, used up instead.
    // The continuation's root request waits on.
    const asking = apply(
      continued,
      binding,
      fact({
        type: "attention-requested",
        requestId: "root:Bash:1",
        actor: null,
        toolName: "Bash",
        kind: "permission",
        startedAt: 3,
      }),
    )!
    const used = stop(asking, 4, { recorded: true })!
    expect(summary(used)).toMatchObject({ state: "working", attention: { pending: 1 } })
    // Its own Stop ends it; should its hook's report never come, its record does.
    expect(summary(stop(used, 5, { background: none })!).state).toBe("idle")
    expect(summary(stop(used, 6, { recorded: true })!).state).toBe("idle")
  })

  it("uses up a continued Stop's record read only after the next Stop, leaving no skip over", () => {
    // Continued twice before the transcript is read: the first record comes behind the
    // second Stop's fence, yet still uses up its own skip.
    const first = apply(
      stop(turn(started(0), 1), 2, { background: none })!,
      binding,
      fact({ type: "turn-continued", startedAt: 2 }),
    )!
    const second = apply(
      stop(first, 5, { background: none })!,
      binding,
      fact({ type: "turn-continued", startedAt: 5 }),
    )!
    const read = stop(stop(second, 3, { recorded: true })!, 6, { recorded: true })!
    expect(read).toMatchObject({ state: "working", skips: 0 })
    // So the continuation's own record ends it, should its hook's report never come.
    expect(summary(stop(read, 8, { recorded: true })!).state).toBe("idle")
  })

  it("ends a continuation at the record naming its turn, used up for no Stop it continued", () => {
    // Codex keeps the turn's id through a continuation, and records only its real end.
    const codex: Binding = { agent: "codex", sessionId: "s", instance: "7" }
    const event = (fields: object) =>
      fact({ agent: "codex", ...fields } as Parameters<typeof fact>[0])
    const running = apply(
      started(0, false),
      codex,
      event({ type: "turn-started", startedAt: 1, turn: "t1" }),
    )!
    const stopped = apply(
      running,
      codex,
      event({ type: "turn-ended", outcome: "completed", startedAt: 2 }),
    )!
    const continued = apply(stopped, codex, event({ type: "turn-continued", startedAt: 2 }))!
    const recorded = (id: string) =>
      apply(
        continued,
        codex,
        event({ type: "turn-ended", outcome: "completed", startedAt: 9, recorded: true, turn: id }),
      )
    expect(recorded("t0")).toBeUndefined()
    expect(summary(recorded("t1")!).state).toBe("idle")
  })

  it("ends a continuation at its Stop when Novadeck's continuing lapsed", () => {
    const stopped = stop(turn(started(0), 1), 2, { background: { agents: 1, tasks: 0 } })!
    const continued = apply(stopped, binding, fact({ type: "turn-continued", startedAt: 2 }))!
    const lapsed = apply(continued, binding, fact({ type: "turn-lapsed", startedAt: 2 }))!
    expect(summary(lapsed)).toMatchObject({ state: "working", background: { agents: 1 } })
    expect(lapsed.state).toBe("idle")
    // Told once: a turn not continued has nothing to lapse.
    expect(apply(lapsed, binding, fact({ type: "turn-lapsed", startedAt: 2 }))).toBeUndefined()
    expect(apply(stopped, binding, fact({ type: "turn-lapsed", startedAt: 2 }))).toBeUndefined()
  })

  it("counts the subagents still running where nothing says, only where their end wakes it", () => {
    const running = subagentStarted(turn(started(0), 1), "a", 2)
    // A failed turn's end, an interrupt of a later turn, an Escape: none says what runs.
    expect(
      summary(
        apply(running, binding, fact({ type: "turn-ended", outcome: "failed", startedAt: 3 }))!,
      ),
    ).toMatchObject({ state: "working", background: { agents: 1, tasks: 0 } })
    expect(
      summary(apply(running, binding, fact({ type: "turn-escaped", startedAt: 3 }))!),
    ).toMatchObject({ state: "working", background: { agents: 1, tasks: 0 } })
    // Codex's subagents never wake it.
    expect(summary(stop({ ...running, wakes: false }, 3)!)).toMatchObject({
      state: "idle",
      background: null,
    })
  })

  it("leaves out the subagents an interrupted turn ended, keeping an earlier background one", () => {
    const earlier = stop(subagentStarted(turn(started(0), 1), "bg", 2), 3)!
    const own = subagentStarted(turn(earlier, 4), "own", 5)
    const interrupted = apply(
      own,
      binding,
      fact({ type: "turn-ended", outcome: "interrupted", startedAt: 6 }),
    )!
    expect(summary(interrupted)).toMatchObject({
      state: "working",
      background: { agents: 1, tasks: 0 },
    })
  })

  it("works on only while an idle status line newer than the Stop counts subagents running", () => {
    const agy: Binding = { agent: "agy", sessionId: "s", instance: "7" }
    const listed = (activity: Activity, startedAt: number, agents: number) =>
      apply(
        activity,
        agy,
        fact({ agent: "agy", type: "turn-idle", startedAt, background: { agents, tasks: 0 } }),
      )
    const ended = (activity: Activity, startedAt: number, more: boolean) =>
      apply(
        activity,
        agy,
        fact({
          agent: "agy",
          type: "turn-ended",
          outcome: "completed",
          startedAt,
          background: { agents: 0, tasks: 0, ...(more && { more: true }) },
        }),
      )!
    const working = apply(
      started(0),
      agy,
      fact({ agent: "agy", type: "turn-started", startedAt: 1 }),
    )!
    // Its Stop says only that something runs on: it works on until its status line,
    // drawn just after, counts the subagents among it.
    const waiting = ended(working, 2, true)
    expect(summary(waiting)).toMatchObject({
      state: "working",
      background: { agents: 0, tasks: 0 },
    })
    const counted = listed(waiting, 3, 2)!
    expect(summary(counted)).toMatchObject({
      state: "working",
      background: { agents: 2, tasks: 0 },
    })
    expect(listed(counted, 4, 2)).toBeUndefined()
    // One drawn before the Stop says nothing of what it left.
    expect(listed(waiting, 1, 3)).toBeUndefined()
    expect(summary(listed(waiting, 3, 0)!)).toMatchObject({
      state: "idle",
      background: { agents: 0, tasks: 0 },
    })
    // Its subagents done, what else its Stop said runs, as a command, which may run for
    // ever, stays, keeping nothing working.
    expect(summary(listed(counted, 5, 0)!)).toMatchObject({
      state: "idle",
      background: { agents: 0, tasks: 0 },
    })
    // Counted, with nothing else said to run, none listed ends it.
    const abnormal = apply(
      working,
      agy,
      fact({ agent: "agy", type: "turn-idle", startedAt: 3, background: { agents: 1, tasks: 0 } }),
    )!
    expect(summary(abnormal)).toMatchObject({ state: "working", background: { agents: 1 } })
    expect(summary(listed(abnormal, 4, 0)!)).toMatchObject({ state: "idle", background: null })
    // With nothing left running, a stale one listing a subagent starts no wait.
    expect(listed(ended(working, 2, false), 3, 1)).toBeUndefined()
  })

  it("ends a turn its records tell ended, once, leaving its hook's Stop to say what runs", () => {
    const running = subagentStarted(turn(started(0), 1), "a", 2)
    const recorded = stop(running, 5, { recorded: true })!
    expect(summary(recorded)).toMatchObject({
      state: "working",
      background: { agents: 1, tasks: 0 },
    })
    // The hook's own Stop, whose hook started before the record was written, still counts.
    expect(summary(stop(recorded, 4, { background: { agents: 1, tasks: 2 } })!)).toMatchObject({
      background: { agents: 1, tasks: 2 },
    })
    // After the hook's Stop, or once idle, the record says nothing new.
    expect(stop(stop(running, 4, { background: none })!, 5, { recorded: true })).toBeUndefined()
    // Nor does one of a turn already over.
    expect(stop(turn(recorded, 6), 5, { recorded: true })).toBeUndefined()
  })

  it("ends only the turn its records name, where both name one", () => {
    const codex: Binding = { agent: "codex", sessionId: "s", instance: "7" }
    const running = apply(
      started(0, false),
      codex,
      fact({ agent: "codex", type: "turn-started", startedAt: 1, turn: "t2" }),
    )!
    const ended = (id: string) =>
      apply(
        running,
        codex,
        fact({
          agent: "codex",
          type: "turn-ended",
          outcome: "failed",
          startedAt: 9,
          recorded: true,
          turn: id,
        }),
      )
    // Codex wrote an earlier failed turn's record late.
    expect(ended("t1")).toBeUndefined()
    expect(summary(ended("t2")!)).toMatchObject({ state: "idle", background: null })
  })
})

describe("how an agent's latest turn ended", () => {
  const binding: Binding = { agent: "claude", sessionId: "s", instance: "7" }
  type Fields = Parameters<typeof fact>[0]
  const on = (activity: Activity, fields: object) =>
    apply(activity, binding, fact(fields as Fields))!
  const turn = (activity: Activity, startedAt: number) =>
    on(activity, { type: "turn-started", cause: "prompt", startedAt })
  const stop = (activity: Activity, startedAt: number, extra: object = {}) =>
    on(activity, { type: "turn-ended", outcome: "completed", startedAt, ...extra })
  const running = turn(started(0), 1)

  it("says nothing before the first turn ends, nor while one runs", () => {
    expect(summary(started(0)).lastTurn).toBeNull()
    expect(summary(running).lastTurn).toBeNull()
    expect(summary(turn(stop(running, 2, { reply: "Done." }), 3)).lastTurn).toBeNull()
  })

  it("tells a completed turn with the start of the agent's reply, where its hook named it", () => {
    expect(summary(stop(running, 2, { reply: "Fixed the flaky spec." })).lastTurn).toEqual({
      outcome: "completed",
      reply: "Fixed the flaky spec.",
      at: 2,
    })
    expect(summary(stop(running, 2)).lastTurn).toEqual({ outcome: "completed", reply: null, at: 2 })
    const failed = stop(running, 2, { outcome: "failed" })
    expect(summary(failed).lastTurn).toEqual({ outcome: "failed", reply: null, at: 2 })
  })

  it("tells the person's interrupt, an Escape and an idle without a Stop apart from completion", () => {
    const interrupted = stop(running, 2, { outcome: "interrupted" })
    expect(summary(interrupted).lastTurn?.outcome).toBe("interrupted")
    const escaped = on(running, { type: "turn-escaped", startedAt: 2 })
    expect(summary(escaped).lastTurn?.outcome).toBe("interrupted")
    const none = { agents: 0, tasks: 0 }
    const quiet = on(running, { type: "turn-idle", startedAt: 2, background: none })
    expect(summary(quiet).lastTurn).toEqual({ outcome: "unknown", reply: null, at: 2 })
  })

  it("tells the end while subagents it left run, the agent working on", () => {
    const background = { agents: 2, tasks: 0 }
    const waiting = stop(running, 2, { reply: "Waiting on two agents.", background })
    expect(summary(waiting)).toMatchObject({
      state: "working",
      lastTurn: { outcome: "completed", reply: "Waiting on two agents.", at: 2 },
    })
  })

  it("hides a continued Stop's end while the continuation runs, and tells it should it lapse", () => {
    const continued = on(stop(running, 2, { reply: "First answer." }), {
      type: "turn-continued",
      startedAt: 2,
    })
    expect(summary(continued).lastTurn).toBeNull()
    const lapsed = on(continued, { type: "turn-lapsed", startedAt: 2 })
    expect(summary(lapsed).lastTurn).toEqual({
      outcome: "completed",
      reply: "First answer.",
      at: 2,
    })
  })

  it("keeps the end its records told when the hook's own Stop comes after, taking its reply", () => {
    const recorded = stop(running, 3, { recorded: true })
    expect(summary(recorded).lastTurn).toEqual({ outcome: "completed", reply: null, at: 3 })
    expect(summary(stop(recorded, 4, { reply: "All green." })).lastTurn).toEqual({
      outcome: "completed",
      reply: "All green.",
      at: 3,
    })
  })

  it("tells a Stop that comes with no turn seen starting as an end of its own", () => {
    // As when the hook of the turn's start never came: its end is a new one all the same.
    const first = stop(running, 2, { reply: "First." })
    expect(summary(stop(first, 5, { reply: "Second." })).lastTurn).toEqual({
      outcome: "completed",
      reply: "Second.",
      at: 5,
    })
  })
})
