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
  const result = (requestId: string, actor: string | null, toolName = "Bash", loose = false) =>
    fact({ type: "attention-resolved", requestId, actor, toolName, loose, outcome: "allowed" })

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

  it("keeps at most 32 subagents", () => {
    let activity = started(0)
    for (let index = 0; index < 40; index += 1)
      activity = apply(activity, binding, subagent("subagent-started", `a${index}`)) ?? activity
    expect(activity.subagents).toHaveLength(32)
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
      harnesses.codex.decode({ ...interrupt(payload), event: "UserPromptSubmit" })
    expect(hook({ session_id: "s", permission_mode: "plan" })).toContainEqual(
      expect.objectContaining({ type: "mode-observed", planning: true }),
    )
    expect(
      hook({ session_id: "s", agent_id: "a", permission_mode: "plan" }).map(({ type }) => type),
    ).not.toContain("mode-observed")
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
