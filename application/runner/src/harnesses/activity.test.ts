import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import type { Report } from "../shell/reports.js"
import { describe, expect, it } from "../test.js"
import { apply, started, summary, type Activity } from "./activity.js"
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

const idle = { state: "idle", attention: { pending: 0, kind: null } }

describe("activity from captured hooks", () => {
  it("waits on the person while Claude Code asks, and works again once allowed", () => {
    const { states, last } = replay("claude", "allow")
    expect(states).toContainEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
    })
    expect(last).toEqual(idle)
  })

  it("asks a question through Claude Code's AskUserQuestion, and settles on the answer", () => {
    const { states, last } = replay("claude", "question")
    expect(states).toContainEqual({ state: "working", attention: { pending: 1, kind: "question" } })
    expect(last).toEqual(idle)
  })

  it("keeps a denied Claude Code request waiting, as nothing reports the denial", () => {
    expect(replay("claude", "deny").last).toEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
    })
  })

  it("ends a Codex turn on Interrupt, settling the request it denied", () => {
    const { states, last } = replay("codex", "deny-then-interrupt")
    expect(states).toContainEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
    })
    expect(last).toEqual(idle)
  })

  it("settles an approved Codex request, whose result no longer describes the call", () => {
    const { states, last } = replay("codex", "approve")
    expect(states).toContainEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
    })
    expect(states).toContainEqual({ state: "working", attention: { pending: 0, kind: null } })
    expect(last).toEqual(idle)
  })

  it("works through Antigravity's model calls and idles at Stop", () => {
    const { states } = replay("agy", "clear")
    expect(states[0]).toEqual({ state: "working", attention: { pending: 0, kind: null } })
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
})
