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
          activity = started(fact.startedAt)
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

const idle = {
  state: "idle",
  attention: { pending: 0, kind: null },
  subagents: [],
  planning: false,
}

describe("activity from captured hooks", () => {
  it("waits on the person while Claude Code asks, and works again once allowed", () => {
    const { states, last } = replay("claude", "allow")
    expect(states).toContainEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
      subagents: [],
      planning: false,
    })
    expect(last).toEqual(idle)
  })

  it("asks a question through Claude Code's AskUserQuestion, and settles on the answer", () => {
    const { states, last } = replay("claude", "question")
    expect(states).toContainEqual({
      state: "working",
      attention: { pending: 1, kind: "question" },
      subagents: [],
      planning: false,
    })
    expect(last).toEqual(idle)
  })

  it("keeps a denied Claude Code request waiting, as nothing reports the denial", () => {
    expect(replay("claude", "deny").last).toEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
      subagents: [],
      planning: false,
    })
  })

  it("ends a Codex turn on Interrupt, settling the request it denied", () => {
    const { states, last } = replay("codex", "deny-then-interrupt")
    expect(states).toContainEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
      subagents: [],
      planning: false,
    })
    expect(last).toEqual(idle)
  })

  it("settles an approved Codex request, whose result no longer describes the call", () => {
    const { states, last } = replay("codex", "approve")
    expect(states).toContainEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
      subagents: [],
      planning: false,
    })
    expect(states).toContainEqual({
      state: "working",
      attention: { pending: 0, kind: null },
      subagents: [],
      planning: false,
    })
    expect(last).toEqual(idle)
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
    })
    expect(states).toContainEqual(idle)
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
    // As Codex's spawned agent asks after the root's turn ended (probed 2026-10-03, 0.159.3).
    const ended = apply(
      asking(),
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
