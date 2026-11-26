import type { AgentActivity } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

import { agentAtWork, watchWorking, type WorkingChange } from "./working.js"

const idle: AgentActivity = {
  state: "idle",
  background: null,
  waiting: null,
  attention: { pending: 0, kind: null },
  planning: false,
  subagents: [],
  lastTurn: null,
}

const changed = (id: string, activity: AgentActivity | null): WorkingChange => ({
  type: "changed",
  terminal: { id, activity },
})

// What the watcher tells for a run of changes.
const told = async (changes: readonly WorkingChange[]): Promise<boolean[]> => {
  const said: boolean[] = []
  await watchWorking(
    (async function* () {
      yield* changes
    })(),
    (working) => said.push(working),
  )
  return said
}

describe("agentAtWork", () => {
  it("counts an agent on a turn", () => {
    expect(agentAtWork({ activity: { ...idle, state: "working" } })).toBe(true)
  })

  it("counts an agent whose turn ended while its subagents run on", () => {
    expect(agentAtWork({ activity: { ...idle, background: { agents: 1, tasks: 0 } } })).toBe(true)
  })

  it("counts an agent waiting on a job or a wake-up of its own", () => {
    const job = { id: "b1", description: null, command: "pnpm test", since: 1, until: null }
    expect(agentAtWork({ activity: { ...idle, waiting: { jobs: [job], wake: null } } })).toBe(true)
    expect(
      agentAtWork({ activity: { ...idle, waiting: { jobs: [], wake: { at: 2, reason: null } } } }),
    ).toBe(true)
  })

  it("leaves out a turn held on the person's answer, but not on a question that doesn't wait", () => {
    const asking = { ...idle, state: "working" as const }
    expect(
      agentAtWork({ activity: { ...asking, attention: { pending: 1, kind: "permission" } } }),
    ).toBe(false)
    expect(
      agentAtWork({
        activity: { ...asking, attention: { pending: 1, kind: "question", detached: 1 } },
      }),
    ).toBe(true)
  })

  it("leaves out an idle agent, one with only commands running on, and a plain shell", () => {
    expect(agentAtWork({ activity: idle })).toBe(false)
    expect(agentAtWork({ activity: { ...idle, background: { agents: 0, tasks: 2 } } })).toBe(false)
    expect(agentAtWork({ activity: { ...idle, state: "unknown" } })).toBe(false)
    expect(agentAtWork({ activity: null })).toBe(false)
  })
})

describe("watchWorking", () => {
  it("tells once an agent starts and once the last one stops", async () => {
    expect(
      await told([
        changed("a", idle),
        { type: "synced" },
        changed("a", { ...idle, state: "working" }),
        changed("b", { ...idle, state: "working" }),
        changed("a", idle),
        changed("b", idle),
      ]),
    ).toEqual([true, false])
  })

  it("says nothing before the listing syncs, then what it found", async () => {
    expect(await told([changed("a", { ...idle, state: "working" }), { type: "synced" }])).toEqual([
      true,
      false,
    ])
  })

  it("counts a closed terminal's agent out", async () => {
    expect(
      await told([
        { type: "synced" },
        changed("a", { ...idle, state: "working" }),
        { type: "removed", terminalId: "a", sessionId: "s" },
        changed("b", idle),
      ]),
    ).toEqual([true, false])
  })

  it("tells nothing when no agent ever works, even as the changes end", async () => {
    expect(await told([changed("a", idle), { type: "synced" }, changed("a", null)])).toEqual([])
  })

  it("lets go once the changes end, as when the runner closes", async () => {
    expect(await told([{ type: "synced" }, changed("a", { ...idle, state: "working" })])).toEqual([
      true,
      false,
    ])
  })
})
