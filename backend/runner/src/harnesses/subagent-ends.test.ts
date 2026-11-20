import { subagentEvents } from "@novadeck/harness-codex/rollout"
import type { HarnessEvent } from "@novadeck/harness-core/events"
import type { Report } from "@novadeck/harness-core/report"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import type { AgentName } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { adapterFolder } from "../testing/adapters.js"
import { apply, started, subagentRef, summary, type Activity } from "./activity.js"
import type { Binding } from "./bindings.js"
import { harnesses } from "./registry.js"

// The subagent-ends probes' captures (subagent-ends.probe.json): each step's hooks, in the
// order the runner heard them.
type Probe = {
  readonly ids: Readonly<Record<string, string>>
  readonly steps: readonly {
    readonly step: string
    readonly hooks: readonly { readonly event: string; readonly payload: Report["payload"] }[]
  }[]
}

/**
 * A capture's activity as the runner would track it, step by step: each hook decoded in
 * order, numbered as it came, the first session it names bound, every later fact applied.
 * `more` adds what a step's other sources say (a rollout's record), after its hooks.
 */
const replay = (
  agent: AgentName,
  more: (step: string, seq: number, binding: Binding) => readonly HarnessEvent[] = () => [],
) => {
  const probe = loadProbe(adapterFolder(agent), "subagent-ends.probe.json") as Probe
  let seq = 0
  let binding: Binding | undefined
  let activity: Activity | undefined
  const take = (fact: HarnessEvent) => {
    if (fact.type === "session-observed") {
      if (!binding) {
        binding = { agent, sessionId: fact.sessionId, instance: null }
        activity = started(fact.startedAt, harnesses[agent].wakes)
      }
      return
    }
    if (fact.type === "telemetry-observed" || !binding || !activity) return
    activity = apply(activity, binding, fact) ?? activity
  }
  const rows: Record<string, { readonly last: readonly string[]; readonly seen: string[] }> = {}
  for (const { step, hooks } of probe.steps) {
    const seen = new Set<string>()
    for (const { event, payload } of hooks) {
      seq += 10
      const report: Report = {
        terminalId: "t",
        token: "0".repeat(48),
        agent,
        event,
        seq,
        instance: null,
        env: { cursor: false },
        payload,
      }
      for (const fact of harnesses[agent].decode(report)) take(fact)
      for (const { id } of activity ? summary(activity).subagents : []) seen.add(id)
    }
    seq += 10
    if (binding) for (const fact of more(step, seq, binding)) take(fact)
    rows[step] = {
      last: activity ? summary(activity).subagents.map(({ id }) => id) : [],
      seen: [...seen],
    }
  }
  return { ids: probe.ids, rows }
}

describe("a subagent that ends unseen, from captured hooks", () => {
  it("leaves Claude Code's tab once TaskStop or the person stopped it, children too, and shows a resumed one again", () => {
    const { ids, rows } = replay("claude")
    const [first, second] = [subagentRef(ids.first!), subagentRef(ids.second!)]
    expect(rows["started"]!.last).toEqual([first])
    expect(rows["stopped by TaskStop"]!.last).toEqual([])
    expect(rows["resumed"]!.last).toEqual([first])
    expect(rows["resumed one finished"]!.last).toEqual([])
    // The second and the two it started, which its root's Stop lists too.
    expect(rows["second and its nested started"]!.last).toHaveLength(3)
    expect(rows["second and its nested started"]!.last).toContain(second)
    expect(rows["a root turn while nested run"]!.last).toHaveLength(3)
    // The person stopped the second: no SubagentStop for it or its children, only the
    // Stop's list without them.
    expect(rows["stopped from the task list"]!.last).toEqual([])
  })

  it("leaves Codex's tab once the root closed it or its turn aborted, and shows a later turn of it again", () => {
    // C's turn aborted on Esc only in its own rollout, which Novadeck follows while it runs.
    const { ids } = loadProbe(adapterFolder("codex"), "subagent-ends.probe.json") as Probe
    const { rows } = replay("codex", (step, seq, binding) =>
      step === "C's request Esc"
        ? subagentEvents(
            JSON.stringify({
              timestamp: new Date(seq).toISOString(),
              type: "event_msg",
              payload: { type: "turn_aborted", reason: "interrupted" },
            }),
            { sessionId: binding.sessionId, instance: binding.instance },
            ids.c!,
            0,
          )
        : [],
    )
    const [a, b, c, d] = ["a", "b", "c", "d"].map((key) => subagentRef(ids[key]!))
    expect(rows["A spawned, held"]!.last).toEqual([a])
    expect(rows["A closed by close_agent"]!.last).toEqual([])
    // resume_agent starts no turn; the input sent to it does, until its stop.
    expect(rows["A resumed"]!.last).toEqual([])
    expect(rows["A messaged"]!.seen).toEqual([a])
    expect(rows["A messaged"]!.last).toEqual([])
    // The person's Esc on the root's turn leaves B running.
    expect(rows["root Esc while B runs"]!.last).toEqual([b])
    expect(rows["C asks"]!.last).toEqual([b, c])
    expect(rows["C's request Esc"]!.last).toEqual([b])
    expect(rows["C messaged again"]!.seen).toEqual([b, c])
    expect(rows["C messaged again"]!.last).toEqual([b])
    expect(rows["D spawned, held"]!.last).toEqual([b, d])
  })
})
