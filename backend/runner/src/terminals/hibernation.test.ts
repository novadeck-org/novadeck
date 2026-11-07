import type { AgentActivity } from "@novadeck/protocol"

import { started } from "../harnesses/activity.js"
import { describe, expect, it } from "../test.js"
import {
  Hibernation,
  mayHibernate,
  vetoOf,
  windowsTree,
  type Facts,
  type HibernationHost,
  type Tree,
  type Veto,
} from "./hibernation.js"
import type { Record } from "./record.js"

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
      lineage: new Map(),
      orphans: new Set(),
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
    ["stray", { processes: processes({ orphans: new Set(["70:3"]) }) }],
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

  it("rests an agent that has no processes under it at all", () => {
    const none = processes({ below: new Set() }, [])
    expect(vetoOf(but({ processes: none }), now)).toBeUndefined()
  })

  it("counts what descends from a baseline process as baseline, however late it starts", () => {
    // npx (22) is recorded; the real server (40) it starts later, and its helper (41), are not.
    const lineage = new Map([
      ["40:2", "22:1"],
      ["41:2", "40:2"],
    ])
    const late = processes({ below: new Set(["22:1", "40:2", "41:2"]), lineage })
    expect(vetoOf(but({ processes: late }), now)).toBeUndefined()
    // A process with no baseline ancestor is still a stray.
    const other = processes({ below: new Set(["22:1", "50:2"]), lineage })
    expect(vetoOf(but({ processes: other }), now)).toBe("stray")
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
    expect([...tree.lineage]).toEqual([])
  })

  it("still finds a job the shell started beside the wrapper", () => {
    const job = [...wrapped, member(30, "node.exe", 10)]
    expect(windowsTree(job, under, 10, 13).beside).toBe(true)
  })

  it("stays conservative where no parent is told: a wrapper counts as a job", () => {
    const bare = wrapped.map(({ parent: _parent, ...rest }) => rest)
    expect(windowsTree(bare, under, 10, 13).beside).toBe(true)
  })

  it("tells a late process of the agent by its parent among them", () => {
    const grandchild = [...wrapped, member(15, "git.exe", 14)]
    const tree = windowsTree(grandchild, [...under, member(15, "git.exe", 14)], 10, 13)
    expect([...tree.lineage]).toEqual([["15:1", "14:1"]])
  })

  it("is not placed where the agent is not in the shell's tree", () => {
    expect(windowsTree(wrapped.slice(0, 3), under, 10, 13).placed).toBe(false)
  })
})

/** A running terminal with an idle agent bound, as the sweep sees it, and a host that notes what it is asked. */
const resting = (
  change: { occupied?: () => boolean; end?: (record: Record) => Promise<void> } = {},
) => {
  const record = {
    summary: { id: "t", handle: "moth", lastProgram: "bash" },
    bound: {
      binding: { agent: "claude", sessionId: "s", instance: "1" },
      activity: started(0),
      telemetry: null,
    },
    agents: { claude: { sessionId: "s", seq: 1, endedAt: 1 } },
    terminal: { exit: null, exiting: false, attached: 0 },
    closed: false,
    changed: false,
    baseline: { instance: "1", begun: true, taken: new Set<string>(), timer: undefined },
  } as unknown as Record
  const calls: string[] = []
  const host = {
    stopping: () => false,
    records: () => [record],
    minutes: () => 1,
    messaging: () => ({
      delivery: () => ({ state: "settled" }),
      occupied: change.occupied ?? (() => false),
    }),
    inbox: () => ({ hasOpenAsk: () => false }),
    approvals: () => ({ involves: () => false }),
    opens: () => ({ asked: () => false }),
    sleepers: () => ({ restable: () => true }),
    detailWatched: () => false,
    trees: () => ({}),
    boxHolds: async () => false,
    save: async () => void calls.push("save"),
    end: async () => {
      calls.push("end")
      await change.end?.(record)
    },
    rested: () => void calls.push("rested"),
  } as unknown as HibernationHost
  const hibernation = new Hibernation(host, { windowMs: 0 })
  const tree: Tree = {
    placed: true,
    foreground: true,
    below: new Set(),
    lineage: new Map(),
    orphans: new Set(),
    beside: false,
  }
  const rest = () =>
    (hibernation as unknown as { rest: (r: Record, s: object) => Promise<void> }).rest(record, {
      tree,
    })
  return { record, calls, hibernation, rest }
}

describe("stopping an agent that looked idle", () => {
  it("saves the screen, ends the agent, and lets the terminal rest, pinning what resumes", async () => {
    const { record, calls, rest, hibernation } = resting()
    const done = rest()
    expect(record.hibernating).toBe(true)
    expect(record.summary.lastProgram).toBe("claude")
    // A create meanwhile waits for it.
    expect(hibernation.settling("t")).toBeDefined()
    await done
    expect(calls).toEqual(["save", "end", "rested"])
    expect(hibernation.settling("t")).toBeUndefined()
  })

  it("leaves it as it was when a message came in while the screen was saved", async () => {
    let occupied = false
    const { record, calls, rest } = resting({ occupied: () => occupied })
    const done = rest()
    // The doorbell would have rung it now; the message is queued for the agent instead.
    occupied = true
    await done
    expect(calls).toEqual(["save"])
    expect(record.hibernating).toBeUndefined()
    expect(record.summary.lastProgram).toBe("bash")
  })

  it("leaves it running when ending its pty failed and the shell is still there", async () => {
    const { record, calls, rest } = resting({ end: () => Promise.reject(new Error("no")) })
    await rest()
    expect(calls).toEqual(["save", "end"])
    expect(record.hibernating).toBeUndefined()
    expect(record.summary.lastProgram).toBe("bash")
  })

  it("rests it all the same when ending failed after the shell had gone", async () => {
    const { calls, rest } = resting({
      end: async (record) => {
        record.terminal = { ...record.terminal, exit: { code: 0, signal: null } } as never
        throw new Error("late")
      },
    })
    await rest()
    expect(calls).toEqual(["save", "end", "rested"])
  })

  it("leaves a terminal closed meanwhile to its close", async () => {
    const { calls, rest } = resting({
      end: async (held) => {
        held.closed = true
      },
    })
    await rest()
    expect(calls).toEqual(["save", "end"])
  })
})
