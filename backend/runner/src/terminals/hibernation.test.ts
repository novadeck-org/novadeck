import type { AgentActivity } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { mayHibernate, vetoOf, windowsTree, type Facts, type Veto } from "./hibernation.js"

const minute = 60_000
const now = 10_000_000

const idle: AgentActivity = {
  state: "idle",
  background: null,
  planning: false,
  waiting: null,
  attention: { pending: 0, kind: null },
  subagents: [],
  lastTurn: null,
}

/** An agent that has been quiet for an hour, in the foreground, with only what it started with. */
const quiet = (): Facts => ({
  windowMs: 30 * minute,
  gone: false,
  agent: "claude",
  resumable: true,
  activity: idle,
  turned: true,
  scheduled: false,
  limited: false,
  asks: false,
  approvals: false,
  occupied: false,
  draft: false,
  attached: false,
  stamps: {
    turn: now - 60 * minute,
    key: now - 45 * minute,
    attach: null,
    born: now - 90 * minute,
  },
  processes: {
    tree: {
      placed: true,
      foreground: true,
      below: new Set(["20:1", "21:1"]),
      beside: false,
    },
    baseline: new Set(["20:1", "21:1", "22:1"]),
  },
})

/** The facts with `change` laid over them. */
const but = (change: Partial<Facts>): Facts => ({ ...quiet(), ...change })

const processes = (tree: Partial<NonNullable<Facts["processes"]>["tree"]>, baseline?: string[]) => {
  const base = quiet().processes!
  return {
    tree: { ...base.tree, ...tree },
    baseline: baseline === undefined ? base.baseline : new Set(baseline),
  }
}

describe("when an agent may be stopped to rest", () => {
  it("may when it has been quiet for its wait with nothing but what it started with", () => {
    expect(vetoOf(quiet(), now)).toBeUndefined()
    expect(mayHibernate(quiet(), now)).toBe(true)
  })

  const vetoes: [Veto, Partial<Facts>][] = [
    ["off", { windowMs: null }],
    ["gone", { gone: true }],
    ["plain", { agent: null, resumable: false }],
    ["unresumable", { resumable: false }],
    ["busy", { activity: null }],
    ["busy", { activity: { ...idle, state: "working" } }],
    ["busy", { activity: { ...idle, background: { agents: 1, tasks: 0 } } }],
    ["busy", { activity: { ...idle, subagents: [{ id: "a", type: null }] } }],
    [
      "busy",
      {
        activity: {
          ...idle,
          waiting: {
            jobs: [
              { id: "j", description: "npm test", command: "npm test", since: 1, until: null },
            ],
            wake: null,
          },
        },
      },
    ],
    ["busy", { activity: { ...idle, waiting: { jobs: [], wake: { at: 1, reason: null } } } }],
    ["scheduled", { scheduled: true }],
    ["attention", { activity: { ...idle, attention: { pending: 1, kind: "question" } } }],
    ["attention", { activity: { ...idle, attention: { pending: 1, kind: null, detached: 1 } } }],
    ["limit", { limited: true }],
    ["ask", { asks: true }],
    ["approval", { approvals: true }],
    ["occupied", { occupied: true }],
    ["draft", { draft: true }],
    ["attached", { attached: true }],
    ["unturned", { turned: false }],
    ["window", { stamps: { ...quiet().stamps, turn: now - minute } }],
    ["window", { stamps: { ...quiet().stamps, key: now - 5 * minute } }],
    ["window", { stamps: { ...quiet().stamps, attach: now - 29 * minute } }],
    ["window", { stamps: { ...quiet().stamps, born: now - 10 * minute } }],
    ["unread", { processes: undefined }],
    ["elsewhere", { processes: processes({ placed: false }) }],
    ["background", { processes: processes({ foreground: false }) }],
    ["unbaselined", { processes: { tree: quiet().processes!.tree, baseline: undefined } }],
    ["stray", { processes: processes({ below: new Set(["20:1", "99:5"]) }) }],
    ["beside", { processes: processes({ beside: true }) }],
  ]

  for (const [veto, change] of vetoes)
    it(`stays awake for ${veto}: ${JSON.stringify(change, (_key, value: unknown) => (value instanceof Set ? [...value] : value)).slice(0, 90)}`, () => {
      expect(vetoOf(but(change), now)).toBe(veto)
      expect(mayHibernate(but(change), now)).toBe(false)
    })

  it("rests when its wait has just passed since each of its turn, key, client and start", () => {
    const wait = 30 * minute
    const edge = (stamp: Partial<Facts["stamps"]>) =>
      vetoOf(but({ stamps: { turn: null, key: null, attach: null, born: 0, ...stamp } }), wait)
    expect(edge({ turn: 0 })).toBeUndefined()
    expect(edge({ turn: 1 })).toBe("window")
    expect(edge({ key: 1 })).toBe("window")
    expect(edge({ attach: 1 })).toBe("window")
    expect(edge({ born: 1 })).toBe("window")
  })

  it("ignores what the baseline held, however many processes it names", () => {
    const held = processes({ below: new Set(["20:1", "21:1", "22:1"]) })
    expect(vetoOf(but({ processes: held }), now)).toBeUndefined()
    // The same pid started again is another process.
    expect(vetoOf(but({ processes: processes({ below: new Set(["20:2"]) }) }), now)).toBe("stray")
  })

  it("keeps an agent with no processes awake only until it has been baselined", () => {
    const none = processes({ below: new Set() }, [])
    expect(vetoOf(but({ processes: none }), now)).toBeUndefined()
  })

  it("names the first thing that keeps it awake", () => {
    expect(vetoOf(but({ windowMs: null, gone: true }), now)).toBe("off")
    expect(vetoOf(but({ asks: true, attached: true, processes: undefined }), now)).toBe("ask")
    expect(vetoOf(but({ draft: true, stamps: { ...quiet().stamps, turn: now } }), now)).toBe(
      "draft",
    )
  })
})

describe("an agent's place in a Windows terminal's tree", () => {
  const member = (pid: number, name: string, parent?: number) => ({
    pid,
    startedAt: 1,
    name,
    ...(parent !== undefined && { parent }),
  })
  // pwsh, codex.cmd's cmd.exe and node.exe, then codex.exe with a tool under it.
  const wrapped = [
    member(10, "pwsh.exe", 1),
    member(11, "cmd.exe", 10),
    member(12, "node.exe", 11),
    member(13, "codex.exe", 12),
    member(14, "rg.exe", 13),
  ]
  const under = wrapped.filter((one) => one.pid >= 13)

  it("counts the wrappers between the shell and the agent as its chain, not a job", () => {
    const tree = windowsTree(wrapped, under, 10, 13)
    expect(tree).toMatchObject({ placed: true, foreground: true, beside: false })
    expect([...tree.below]).toEqual(["14:1"])
  })

  it("still finds a job the shell started beside the wrapper", () => {
    const job = [...wrapped, member(30, "node.exe", 10)]
    expect(windowsTree(job, under, 10, 13).beside).toBe(true)
  })

  it("stays conservative where no parent is told: a wrapper counts as a job", () => {
    const bare = wrapped.map(({ parent: _parent, ...rest }) => rest)
    expect(windowsTree(bare, under, 10, 13).beside).toBe(true)
  })

  it("is not placed where the agent is not in the shell's tree", () => {
    expect(windowsTree(wrapped.slice(0, 3), under, 10, 13).placed).toBe(false)
  })
})
