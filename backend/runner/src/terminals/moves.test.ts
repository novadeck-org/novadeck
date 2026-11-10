import type { TerminalMove } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import type { Messaging } from "../messaging/messaging.js"
import { describe, expect, it } from "../test.js"
import type { Approvals } from "./approvals.js"
import { leadNotice } from "./leads.js"
import { Moves, moveNotice, type MovesHost, type MoveSessions } from "./moves.js"
import type { OpenRequests } from "./opens.js"
import type { Record } from "./record.js"
import type { Sleepers } from "./sleepers.js"

type Spec = {
  readonly session: string
  readonly handle: string
  readonly ledBy?: string
  /** Kept only as saved, with no record: a sleeper unless it is in `plain`. */
  readonly saved?: true
  readonly closed?: true
  readonly hibernating?: true
  /** A brief its lead sent it has not arrived. */
  readonly brief?: true
  /** An approval the person hasn't answered names it. */
  readonly approval?: true
}

const words = ["owl", "crow", "kite", "raven"]

// Moves over a runner of fakes: terminals by id with the session they are in, the handles
// each session has given, and a log of what was saved, announced, noticed and moved.
const setup = (
  terminals: { [id: string]: Spec },
  options: { given?: string[]; asleep?: readonly string[]; waking?: readonly string[] } = {},
) => {
  const records = new Map<string, Record>()
  const rows = new Map<
    string,
    {
      id: string
      sessionId: string
      handle: string
      command: string
      naming: object
      ledBy: string | null
      openedBy: string | null
    }
  >()
  for (const [id, spec] of Object.entries(terminals)) {
    if (spec.saved)
      rows.set(id, {
        id,
        sessionId: spec.session,
        handle: spec.handle,
        command: "claude",
        naming: { person: null, opener: null, murmur: null, own: { title: `Title of ${id}` } },
        ledBy: spec.ledBy ?? null,
        openedBy: null,
      })
    else
      records.set(id, {
        summary: {
          id,
          handle: spec.handle,
          title: `Title of ${id}`,
          titleSource: { kind: "agent", by: spec.handle },
          command: "claude",
          sessionId: spec.session,
          ledBy: spec.ledBy ?? null,
        },
        naming: { person: null, opener: null, murmur: null, own: { title: `Title of ${id}` } },
        openedBy: null,
        closed: spec.closed === true,
        hibernating: spec.hibernating,
        suspended: "stopped",
      } as unknown as Record)
  }
  // Every handle a session gave, as `session/handle`: those its terminals have, and more.
  const given = new Set([
    ...Object.values(terminals).map((each) => `${each.session}/${each.handle}`),
    ...(options.given ?? []),
  ])
  const log = {
    saved: [] as { id: string; sessionId: string; handle: string; ledBy: string | null }[],
    announced: [] as string[],
    notices: [] as { to: string; text: string }[],
    dropped: [] as string[],
    ended: [] as string[],
    moved: [] as { id: string; sessionId: string; handle: string; ledBy: string | null }[],
    inbox: [] as { id: string; sessionId: string; handle: string }[],
    items: [] as string[],
    sleepers: [] as string[],
    savedChanged: [] as string[],
    feedback: [] as { id: string; sessionId: string; handle: string }[],
    shadows: [] as { summary?: Record["summary"]; openedBy?: string | null }[],
  }
  let closing = new Set<string>()
  const rowOf = (record: Record) => ({
    id: record.summary.id,
    sessionId: record.summary.sessionId,
    handle: record.summary.handle,
    ledBy: record.summary.ledBy,
    openedBy: record.openedBy,
  })
  const host: MovesHost = {
    stopping: () => false,
    records: () => records,
    closed: () => false,
    closingNow: () => false,
    closingSession: (sessionId) => closing.has(sessionId),
    saves: () =>
      ({
        saved: (id: string) => rows.get(id),
        terminals: (sessionId: string) =>
          [...[...records.values()].map(rowOf), ...rows.values()].filter(
            (each) => each.sessionId === sessionId,
          ),
        saveTogether: (
          list: readonly {
            id?: string
            summary?: Record["summary"]
            sessionId?: string
            handle?: string
            ledBy?: string | null
          }[],
        ) => {
          for (const each of list) {
            log.shadows.push(each as never)
            const row = each.summary
              ? {
                  id: each.summary.id,
                  sessionId: each.summary.sessionId,
                  handle: each.summary.handle,
                  ledBy: each.summary.ledBy,
                }
              : {
                  id: each.id!,
                  sessionId: each.sessionId!,
                  handle: each.handle!,
                  ledBy: each.ledBy ?? null,
                }
            log.saved.push(row)
            const kept = rows.get(row.id)
            if (kept) rows.set(row.id, { ...kept, ...row })
          }
          return true
        },
      }) as never,
    sleepers: () =>
      ({
        waking: (id: string) => options.waking?.includes(id) === true,
        move: (row: { id: string }) => {
          log.sleepers.push(row.id)
          return options.asleep?.includes(row.id) === true
        },
      }) as unknown as Sleepers,
    messaging: () =>
      ({
        notice: (to: string, text: string) => log.notices.push({ to, text }),
        briefOf: (id: string) => (terminals[id]?.brief ? "message" : undefined),
        dropLeadMessages: (id: string) => log.dropped.push(id),
        endLead: (id: string) => log.ended.push(id),
        move: (id: string, scope: { sessionId: string }, handle: string, ledBy: string | null) =>
          log.moved.push({ id, sessionId: scope.sessionId, handle, ledBy }),
      }) as unknown as Messaging,
    inbox: () =>
      ({
        moved: (id: string, sessionId: string, handle: string) =>
          log.inbox.push({ id, sessionId, handle }),
      }) as never,
    feedback: () =>
      ({
        moved: (id: string, sessionId: string, handle: string) =>
          log.feedback.push({ id, sessionId, handle }),
      }) as never,
    approvals: () =>
      ({ involves: (id: string) => terminals[id]?.approval === true }) as unknown as Approvals,
    opens: () => ({ involves: () => false }) as unknown as OpenRequests,
    items: () => ({ terminalMoved: (id: string) => log.items.push(id) }) as never,
    announce: (record) => log.announced.push(record.summary.id),
    savedChanged: (row) => log.savedChanged.push(row.id),
    adopt: (sessionId, handle) => {
      const key = `${sessionId}/${handle}`
      if (given.has(key)) return false
      given.add(key)
      return true
    },
    draw: (sessionId) => {
      const handle = words.find((each) => !given.has(`${sessionId}/${each}`))!
      given.add(`${sessionId}/${handle}`)
      return handle
    },
  }
  const projects = new Map([
    ["s1", "p1"],
    ["s2", "p1"],
    ["s3", "p2"],
  ])
  const sessions: MoveSessions = {
    projectOf: (sessionId) => {
      const project = projects.get(sessionId)
      if (!project) throw new DomainError("NOT_FOUND", "Session not found")
      return project
    },
  }
  const moves = new Moves(host)
  return {
    records,
    rows,
    log,
    closing: (sessionId: string) => (closing = new Set([...closing, sessionId])),
    move: (input: TerminalMove) => moves.move(input, sessions),
  }
}

const to = (
  sessionId: string,
  terminalId: string,
  extra: Partial<TerminalMove> = {},
): TerminalMove => ({
  terminalId,
  to: { sessionId },
  ...extra,
})

const failure = (work: () => unknown): string | undefined => {
  try {
    work()
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error)
  }
  return undefined
}

describe("moving a terminal to another session", () => {
  it("keeps its handle, and tells watchers, messaging, the inbox, its bar and its saved row", () => {
    const world = setup({ a: { session: "s1", handle: "moth" } })
    const moved = world.move(to("s2", "a"))
    expect(moved).toEqual({
      sessionId: "s2",
      moved: [{ terminalId: "a", handle: "moth", was: "moth" }],
      left: null,
    })
    expect(world.records.get("a")!.summary).toMatchObject({ sessionId: "s2", handle: "moth" })
    expect(world.log.saved).toEqual([{ id: "a", sessionId: "s2", handle: "moth", ledBy: null }])
    expect(world.log.announced).toEqual(["a"])
    expect(world.log.moved).toEqual([{ id: "a", sessionId: "s2", handle: "moth", ledBy: null }])
    expect(world.log.inbox).toEqual([{ id: "a", sessionId: "s2", handle: "moth" }])
    expect(world.log.items).toEqual(["a"])
    expect(world.log.notices).toEqual([{ to: "a", text: moveNotice.alone() }])
  })

  it("tells a team that moved with every handle kept that it moved, each of its agents", () => {
    const world = setup({
      lead: { session: "s1", handle: "moth" },
      worker: { session: "s1", handle: "fox", ledBy: "moth" },
    })
    world.move(to("s2", "lead"))
    expect(world.log.notices).toEqual([
      { to: "lead", text: moveNotice.alone() },
      { to: "worker", text: moveNotice.alone() },
    ])
  })

  it("draws the next handle of the session where a terminal there has it", () => {
    const world = setup({
      a: { session: "s1", handle: "moth" },
      b: { session: "s2", handle: "moth" },
    })
    const moved = world.move(to("s2", "a"))
    expect(moved.moved).toEqual([{ terminalId: "a", handle: "owl", was: "moth" }])
    expect(world.records.get("a")!.summary.handle).toBe("owl")
    expect(world.log.notices.map(({ to: who }) => who)).toEqual(["a"])
    expect(world.records.get("a")!.summary.titleSource).toEqual({ kind: "agent", by: "owl" })
  })

  it("draws the next handle where the session gave its own to a closed terminal", () => {
    const world = setup({ a: { session: "s1", handle: "moth" } }, { given: ["s2/moth"] })
    expect(world.move(to("s2", "a")).moved[0]!.handle).toBe("owl")
  })

  it("draws the next handle where a terminal there is led under it", () => {
    const world = setup({
      a: { session: "s1", handle: "moth" },
      b: { session: "s2", handle: "fox", ledBy: "moth" },
    })
    expect(world.move(to("s2", "a")).moved[0]!.handle).toBe("owl")
  })

  it("takes its whole team at every depth, and the workers follow a lead's new handle", () => {
    const world = setup(
      {
        lead: { session: "s1", handle: "moth" },
        worker: { session: "s1", handle: "fox", ledBy: "moth" },
        deep: { session: "s1", handle: "lynx", ledBy: "fox" },
        sleeper: { session: "s1", handle: "wisp", ledBy: "lynx", saved: true },
        other: { session: "s1", handle: "dusk" },
        taken: { session: "s2", handle: "moth" },
        taken2: { session: "s2", handle: "lynx" },
      },
      { asleep: ["sleeper"] },
    )
    const moved = world.move(to("s2", "lead"))
    expect(moved.moved).toEqual([
      { terminalId: "lead", handle: "owl", was: "moth" },
      { terminalId: "worker", handle: "fox", was: "fox" },
      { terminalId: "deep", handle: "crow", was: "lynx" },
      { terminalId: "sleeper", handle: "wisp", was: "wisp" },
    ])
    expect(moved.left).toBeNull()
    expect(world.records.get("worker")!.summary.ledBy).toBe("owl")
    expect(world.records.get("deep")!.summary.ledBy).toBe("fox")
    expect(world.rows.get("sleeper")).toMatchObject({
      sessionId: "s2",
      handle: "wisp",
      ledBy: "crow",
    })
    // One save for the whole team, and the terminal that is not on it stays.
    expect(world.log.saved.map(({ id }) => id)).toEqual(["lead", "worker", "deep", "sleeper"])
    expect(world.records.get("other")!.summary.sessionId).toBe("s1")
    expect(world.log.sleepers).toEqual(["sleeper"])
    expect(world.log.savedChanged).toEqual([])
  })

  it("tells every running member of a moved team the renames, the nested ones too", () => {
    const world = setup(
      {
        lead: { session: "s1", handle: "moth" },
        worker: { session: "s1", handle: "fox", ledBy: "moth" },
        deep: { session: "s1", handle: "lynx", ledBy: "fox" },
        taken: { session: "s2", handle: "lynx" },
      },
      {},
    )
    world.move(to("s2", "lead"))
    const renames = [{ was: "lynx", now: "owl" }]
    expect(world.log.notices).toEqual([
      { to: "lead", text: moveNotice.renamed("moth", renames) },
      { to: "worker", text: moveNotice.renamed("fox", renames) },
      { to: "deep", text: moveNotice.renamed("owl", renames) },
    ])
    expect(world.log.notices[1]!.text).toContain("@lynx is now @owl")
  })

  it("tells a running terminal moved alone, unchanged, that it sees another session now", () => {
    const world = setup({
      lead: { session: "s1", handle: "moth" },
      worker: { session: "s1", handle: "fox" },
    })
    world.move(to("s2", "worker"))
    expect(world.log.notices).toEqual([{ to: "worker", text: moveNotice.alone() }])
  })

  it("tells the running lead of a sleeping worker moved alone", () => {
    const world = setup(
      {
        lead: { session: "s1", handle: "moth" },
        sleeper: { session: "s1", handle: "fox", ledBy: "moth", saved: true },
      },
      { asleep: ["sleeper"] },
    )
    world.move(to("s2", "sleeper"))
    expect(world.log.notices).toEqual([
      { to: "lead", text: moveNotice.leftBy("fox", "Title of sleeper") },
    ])
  })

  it("tells the lead an undo rejoins that it leads the terminal again", () => {
    const world = setup({
      a: { session: "s1", handle: "owl" },
      lead: { session: "s2", handle: "moth" },
    })
    world.move(to("s2", "a", { handles: { a: "owl" }, lead: "moth" }))
    expect(world.log.notices).toEqual([
      { to: "lead", text: moveNotice.leadsAgain("owl", "Title of a") },
      { to: "a", text: leadNotice.nowLed("moth") },
    ])
  })

  it("leaves its lead when moved on its own, and says which it left", () => {
    const world = setup({
      lead: { session: "s1", handle: "moth" },
      worker: { session: "s1", handle: "fox", ledBy: "moth" },
    })
    const moved = world.move(to("s2", "worker"))
    expect(moved.left).toBe("moth")
    expect(world.records.get("worker")!.summary).toMatchObject({ sessionId: "s2", ledBy: null })
    expect(world.records.get("worker")!.suspended).toBeNull()
    expect(world.log.dropped).toEqual(["worker"])
    expect(world.log.ended).toEqual(["worker"])
    expect(world.log.notices).toEqual([
      { to: "lead", text: moveNotice.leftBy("fox", "Title of worker") },
      { to: "worker", text: moveNotice.left("moth") },
    ])
    expect(world.records.get("lead")!.summary.sessionId).toBe("s1")
  })

  it("moves a terminal kept only as saved, a sleeper, and tells watchers through it", () => {
    const world = setup({ z: { session: "s1", handle: "moth", saved: true } }, { asleep: ["z"] })
    world.move(to("s2", "z"))
    expect(world.rows.get("z")).toMatchObject({ sessionId: "s2", handle: "moth" })
    expect(world.log.sleepers).toEqual(["z"])
    expect(world.log.inbox).toEqual([{ id: "z", sessionId: "s2", handle: "moth" }])
    expect(world.log.notices).toEqual([])
  })

  it("tells watchers itself of a saved terminal that is no sleeper", () => {
    const world = setup({ z: { session: "s1", handle: "moth", saved: true } })
    world.move(to("s2", "z"))
    expect(world.log.savedChanged).toEqual(["z"])
  })

  it("takes its old handle back for an undo, though the session gave it already, and its lead", () => {
    const world = setup(
      {
        a: { session: "s1", handle: "owl", ledBy: "x" },
        lead: { session: "s2", handle: "moth" },
      },
      { given: ["s2/fox"] },
    )
    const moved = world.move(to("s2", "a", { handles: { a: "fox" }, lead: "moth" }))
    expect(moved.moved[0]).toEqual({ terminalId: "a", handle: "fox", was: "owl" })
    expect(world.records.get("a")!.summary.ledBy).toBe("moth")
    expect(world.log.moved[0]).toMatchObject({ handle: "fox", ledBy: "moth" })
  })

  it("draws a handle for an undo whose handle a terminal there holds, and ignores a lead that is gone", () => {
    const world = setup({
      a: { session: "s1", handle: "owl" },
      b: { session: "s2", handle: "fox" },
    })
    const moved = world.move(to("s2", "a", { handles: { a: "fox" }, lead: "nobody" }))
    expect(moved.moved[0]!.handle).toBe("owl")
    expect(world.records.get("a")!.summary.ledBy).toBeNull()
  })

  it("fails as the contract says", () => {
    const world = setup(
      {
        a: { session: "s1", handle: "moth" },
        closing: { session: "s1", handle: "fox", closed: true },
        resting: { session: "s1", handle: "lynx", hibernating: true },
        waking: { session: "s1", handle: "wisp", saved: true },
      },
      { waking: ["waking"] },
    )
    expect(failure(() => world.move(to("s2", "nothing")))).toBe("TERMINAL_NOT_FOUND")
    expect(failure(() => world.move(to("s9", "a")))).toBe("NOT_FOUND")
    expect(failure(() => world.move(to("s1", "a")))).toBe("CONFLICT")
    expect(failure(() => world.move(to("s3", "a")))).toBe("CONFLICT")
    expect(failure(() => world.move(to("s2", "closing")))).toBe("CONFLICT")
    expect(failure(() => world.move(to("s2", "resting")))).toBe("CONFLICT")
    expect(failure(() => world.move(to("s2", "waking")))).toBe("CONFLICT")
    world.closing("s2")
    expect(failure(() => world.move(to("s2", "a")))).toBe("CONFLICT")
    world.closing("s1")
    expect(failure(() => world.move(to("s2", "a")))).toBe("CONFLICT")
    expect(world.log.saved).toEqual([])
  })

  it("is a conflict while a member has a brief that has not arrived", () => {
    const world = setup({
      lead: { session: "s1", handle: "moth" },
      worker: { session: "s1", handle: "fox", ledBy: "moth", brief: true },
    })
    expect(failure(() => world.move(to("s2", "lead")))).toBe("CONFLICT")
    expect(failure(() => world.move(to("s2", "worker")))).toBe("CONFLICT")
    expect(world.log.saved).toEqual([])
  })

  it("is a conflict while an approval names a member, and withdraws nothing", () => {
    const world = setup({
      lead: { session: "s1", handle: "moth" },
      worker: { session: "s1", handle: "fox", ledBy: "moth", approval: true },
    })
    expect(failure(() => world.move(to("s2", "lead")))).toBe("CONFLICT")
    expect(failure(() => world.move(to("s2", "worker")))).toBe("CONFLICT")
    expect(world.log.saved).toEqual([])
  })

  it("saves the summary and opener it puts in memory, and tells the feedback draft", () => {
    const world = setup(
      {
        lead: { session: "s1", handle: "moth" },
        worker: { session: "s1", handle: "fox", ledBy: "moth" },
        other: { session: "s2", handle: "moth" },
      },
      {},
    )
    world.records.get("worker")!.openedBy = "moth"
    world.move(to("s2", "lead"))
    const saved = world.log.shadows.find((each) => each.summary?.id === "worker")!
    const worker = world.records.get("worker")!
    expect(saved.summary).toEqual(worker.summary)
    expect(saved.openedBy).toBe(worker.openedBy)
    expect(worker.openedBy).toBe(world.records.get("lead")!.summary.handle)
    expect(worker.openedBy).not.toBe("moth")
    expect(world.log.feedback).toContainEqual({
      id: "worker",
      sessionId: "s2",
      handle: "fox",
    })
  })

  it("moves none of a team when one of its members can't move", () => {
    const world = setup({
      lead: { session: "s1", handle: "moth" },
      worker: { session: "s1", handle: "fox", ledBy: "moth", hibernating: true },
    })
    expect(failure(() => world.move(to("s2", "lead")))).toBe("CONFLICT")
    expect(world.records.get("lead")!.summary.sessionId).toBe("s1")
  })
})
