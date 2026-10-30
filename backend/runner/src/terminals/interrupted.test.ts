import type { Report } from "@novadeck/harness-core/report"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import type { AgentName } from "@novadeck/protocol"

import { apply, started, summary, type Activity } from "../harnesses/activity.js"
import { observe } from "../harnesses/bindings.js"
import type { Binding } from "../harnesses/bindings.js"
import { harnesses } from "../harnesses/registry.js"
import { describe, expect, it } from "../test.js"
import { adapterFolder } from "../testing/adapters.js"
import { interruptedFor, markTurn, restored, tellInterrupted, turnOf } from "./interrupted.js"
import type { Record } from "./record.js"
import type { AgentReport } from "./saved-terminals.js"

type Held = Pick<Record, "resumeClaim" | "resumeTold" | "resumeTurn" | "bound">

const resumed = (extra: Partial<Held> = {}): Held => ({
  resumeClaim: "claude:s1",
  resumeTold: undefined,
  resumeTurn: "running",
  bound: null,
  ...extra,
})

/** What the turn flag reads after each fact of a captured scenario, as the runner tracks it. */
const flags = (agent: AgentName, probe: string, name: string) => {
  const { scenarios } = loadProbe(adapterFolder(agent), probe) as {
    scenarios: { [name: string]: { events: { event: string; payload: Report["payload"] }[] } }
  }
  // Bound to the session its first fact names.
  let binding: Binding | undefined
  let activity: Activity = started(0, harnesses[agent].wakes)
  const read: ReturnType<typeof turnOf>[] = []
  scenarios[name]!.events.forEach(({ event, payload }, index) => {
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
      if (fact.type === "telemetry-observed") continue
      binding ??= { agent, sessionId: fact.sessionId, instance: null }
      if (fact.type === "session-observed") continue
      const next = apply(activity, binding, fact)
      if (next) read.push(turnOf(summary((activity = next))))
    }
  })
  return read
}

describe("what a turn was doing, for every harness", () => {
  it("is running while a Claude Code turn works, not while it asks the person, nor once done", () => {
    const read = flags("claude", "interactive.probe.json", "allow")
    expect(read).toContain("running")
    expect(read).toContain(undefined)
    // The request pending in the middle of the turn reads as nothing; a finished turn too.
    expect(read.at(-1)).toBeUndefined()
    const asking = flags("claude", "interactive.probe.json", "question")
    expect(asking.indexOf(undefined)).toBeGreaterThan(asking.indexOf("running"))
    expect(flags("claude", "interactive.probe.json", "plan").at(-1)).toBeUndefined()
  })

  it("is running while a Codex turn works, and nothing while a request waits or after it", () => {
    const read = flags("codex", "interactive.probe.json", "approve")
    const first = read.indexOf("running")
    expect(first).toBeGreaterThanOrEqual(0)
    expect(read.indexOf(undefined, first)).toBeGreaterThan(first)
    expect(read.at(-1)).toBeUndefined()
    // Escaped after a denial: not cut, the person stopped it.
    expect(flags("codex", "interactive.probe.json", "deny-then-interrupt").at(-1)).toBeUndefined()
  })

  it("is running while an Antigravity turn works, and nothing once it idles", () => {
    const read = flags("agy", "interactive.probe.json", "clear")
    expect(read[0]).toBe("running")
    expect(read.at(-1)).toBeUndefined()
  })

  it("is waking while an idle agent waits on a wake-up or a background command it set", () => {
    for (const [agent, scenario] of [
      ["claude", "wake-up"],
      ["claude", "background-command"],
      ["agy", "timer"],
      ["agy", "background-command"],
    ] as const)
      expect(flags(agent, "waiting.probe.json", scenario), `${agent} ${scenario}`).toContain(
        "waking",
      )
    // A daemon left running is no wait.
    expect(flags("agy", "waiting.probe.json", "daemon")).not.toContain("waking")
  })

  it("is nothing without activity, and nothing while the person's request is pending", () => {
    expect(turnOf(null)).toBeUndefined()
    const idle = summary(started(0))
    expect(turnOf(idle)).toBeUndefined()
    expect(turnOf({ ...idle, state: "working" })).toBe("running")
    expect(
      turnOf({ ...idle, state: "working", attention: { pending: 1, kind: "permission" } }),
    ).toBeUndefined()
    expect(turnOf({ ...idle, state: "unknown" })).toBeUndefined()
  })
})

describe("keeping the turn in a terminal's sessions", () => {
  const binding: Binding = { agent: "claude", sessionId: "s1", instance: "1" }
  const running = { ...summary(started(0)), state: "working" } as const
  const terminal = (agents: Record["agents"]) =>
    ({ agents, bound: { binding, activity: started(0), telemetry: null } }) as Pick<
      Record,
      "agents" | "bound"
    >

  it("sets it on the bound session, only when it changes, and clears it with the turn", () => {
    const record = terminal({ claude: { sessionId: "s1", seq: 1 } })
    expect(markTurn(record, running)).toBe(true)
    expect(record.agents.claude).toEqual({ sessionId: "s1", seq: 1, turn: "running" })
    expect(markTurn(record, running)).toBe(false)
    expect(markTurn(record, summary(started(0)))).toBe(true)
    expect(record.agents.claude).toEqual({ sessionId: "s1", seq: 1 })
  })

  it("sets it on no session the bound one is not, and clears it when none is bound", () => {
    const other = terminal({ claude: { sessionId: "older", seq: 1 } })
    expect(markTurn(other, running)).toBe(false)
    const gone: Pick<Record, "agents" | "bound"> = {
      agents: { claude: { sessionId: "s1", seq: 1, turn: "running" } },
      bound: null,
    }
    expect(markTurn(gone, null)).toBe(true)
    expect(gone.agents.claude).toEqual({ sessionId: "s1", seq: 1 })
  })

  it("stays with a session as it reports again, and starts over with another", () => {
    const state = (sessions: Record["agents"]) => ({ sessions, binding: null, cwd: "/" })
    const event = (sessionId: string, startedAt: number) =>
      ({ type: "session-observed", agent: "claude", sessionId, startedAt, instance: "1" }) as never
    const facts = { connected: true, shellInForeground: false, platform: "linux" } as never
    const kept = { claude: { sessionId: "s1", seq: 1, turn: "running" as const } }
    expect(observe(state(kept), event("s1", 2), facts)?.sessions.claude).toEqual({
      sessionId: "s1",
      seq: 2,
      turn: "running",
    })
    expect(observe(state(kept), event("s2", 2), facts)?.sessions.claude).toEqual({
      sessionId: "s2",
      seq: 2,
    })
  })

  it("is dropped on restore, and kept apart only for the agent that resumes", () => {
    const saved: Record["agents"] = {
      claude: { sessionId: "s1", seq: 1, turn: "waking" },
      codex: { sessionId: "c1", seq: 1, turn: "running" },
    }
    const launch: Pick<Held, "resumeTurn"> = {}
    const agents = restored(saved, "claude", launch)
    expect(launch.resumeTurn).toBe("waking")
    expect(agents).toEqual({
      claude: { sessionId: "s1", seq: 1 },
      codex: { sessionId: "c1", seq: 1 },
    })
    expect(saved.claude?.turn).toBe("waking")
    // Not resumed: nothing to tell, and the saved flags are still dropped.
    expect(restored(saved, false, launch)).toEqual(agents)
    expect(launch.resumeTurn).toBeUndefined()
    // A row saved before turns existed, or no row, comes as it is.
    const old: Record["agents"] = { claude: { sessionId: "s1", seq: 1 } as AgentReport }
    expect(restored(old, "claude", launch)).toBe(old)
    expect(restored(undefined, "claude", launch)).toEqual({})
  })
})

describe("the notice to a resumed agent whose turn the stop cut short", () => {
  it("says what stopped and to carry on, for a turn that ran, once", () => {
    const record = resumed()
    const notice = interruptedFor(record, "claude", { sessionId: "s1" })
    expect(notice).toContain("Novadeck: automatic notice, not from the user:")
    expect(notice).toContain("while your turn was running")
    expect(notice).toContain("subagents")
    expect(record.resumeTold).toBe(true)
    expect(record.resumeTurn).toBeUndefined()
    expect(
      interruptedFor({ ...record, resumeTurn: "running" }, "claude", { sessionId: "s1" }),
    ).toBeUndefined()
  })

  it("says it will not wake the agent, for one that waited on its own work", () => {
    const notice = interruptedFor(resumed({ resumeTurn: "waking" }), "claude", { sessionId: "s1" })
    expect(notice).toContain("background command or a wake-up")
    expect(notice).toContain("will not wake you")
  })

  it("tells nothing where the agent carried no turn, judging once whatever it turns out to be", () => {
    const record = resumed({ resumeTurn: undefined })
    expect(interruptedFor(record, "claude", { sessionId: "s1" })).toBeUndefined()
    expect(record.resumeTold).toBe(true)
  })

  it("tells nothing where no shell resumed an agent, or another agent than the one resumed", () => {
    expect(
      interruptedFor(resumed({ resumeClaim: undefined }), "claude", { sessionId: "s1" }),
    ).toBeUndefined()
    expect(
      interruptedFor(resumed({ resumeClaim: "codex:s1" }), "claude", { sessionId: "s1" }),
    ).toBeUndefined()
  })

  it("tells nothing of another session than the one resumed, by id or by the prefix a prompt showed", () => {
    expect(interruptedFor(resumed(), "claude", { sessionId: "s2" })).toBeUndefined()
    expect(interruptedFor(resumed(), "claude", { prefix: "x" })).toBeUndefined()
    expect(interruptedFor(resumed(), "claude", { prefix: "s" })).toContain("automatic notice")
    expect(interruptedFor(resumed(), "claude", { prefix: null })).toContain("automatic notice")
  })

  it("tells nothing once a turn runs meanwhile", () => {
    const bound = { activity: { ...started(0), state: "working" } } as unknown as Held["bound"]
    expect(interruptedFor(resumed({ bound }), "claude", { sessionId: "s1" })).toBeUndefined()
  })

  it("is sent as a message for the terminal, once, and a failure is only logged", () => {
    const sent: string[] = []
    const record = { ...resumed(), summary: { id: "t1" } } as never
    tellInterrupted(
      record,
      "claude",
      { sessionId: "s1" },
      { notice: (id, text) => !!sent.push(`${id}:${text}`) },
    )
    tellInterrupted(
      record,
      "claude",
      { sessionId: "s1" },
      { notice: (id, text) => !!sent.push(`${id}:${text}`) },
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^t1:Novadeck: automatic notice/)
    const again = { ...resumed(), summary: { id: "t1" } } as never
    expect(() =>
      tellInterrupted(
        again,
        "claude",
        { sessionId: "s1" },
        {
          notice: () => {
            throw new Error("broken")
          },
        },
      ),
    ).not.toThrow()
  })
})
