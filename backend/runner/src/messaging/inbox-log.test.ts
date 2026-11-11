import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { agentNames, type AgentName } from "@novadeck/protocol"
import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { storeWith } from "../testing/workspace.js"
import { Inbox, memoryInbox, type InboxRecords, type TurnFields, type TurnOwner } from "./inbox.js"
import { retentionMs } from "./messages.js"
import { standingDone } from "./peers.js"
import { keptReports, keptTurns, type LoggedReport } from "./report-log.js"

const projectId = randomUUID()
const workspaceSessionId = randomUUID()
const spacing = 7_000

const turnFields = (reply: string | null = "All done."): TurnFields => ({
  outcome: "completed",
  reply,
  error: null,
  files: [],
})

// An Inbox over `records` whose terminals, and the agent session each has bound, are the
// test's to say, as the runner's messaging says them, with a clock the test moves.
const setup = (
  records: InboxRecords = memoryInbox(),
  host: {
    keeps?: (rows: readonly LoggedReport[]) => ((row: LoggedReport) => boolean) | undefined
  } = {},
) => {
  const owners = new Map<string, TurnOwner>()
  const alive = new Set<string>()
  let at = 1_000_000
  const inbox = new Inbox(
    {
      owner: (id) => owners.get(id),
      reply: () => {
        throw new Error("no reply")
      },
      replyState: () => undefined,
      forgetReplies: () => {},
      changed: () => {},
      exists: (id) => alive.has(id),
      ...host,
    },
    records,
    () => at,
    { sweepMs: 0 },
  )
  const open = (terminalId: string, agent: AgentName, sessionId: string): TurnOwner => {
    const owner = { terminalId, projectId, workspaceSessionId, handle: "moth", agent, sessionId }
    owners.set(terminalId, owner)
    alive.add(terminalId)
    return owner
  }
  const say = (terminalId: string, kind: "done" | "tell", subject: string, body = "Body") => {
    at += spacing
    const sent = inbox.call(terminalId, kind, { subject, body })
    if (!sent.ok) throw new Error(sent.reason)
    return sent.id
  }
  return {
    inbox,
    owners,
    alive,
    open,
    say,
    advance: (ms: number) => (at += ms),
    now: () => at,
    close: (terminalId: string) => {
      alive.delete(terminalId)
      owners.delete(terminalId)
      inbox.reconcile(terminalId)
    },
  }
}

const sessions = (records: InboxRecords) =>
  records
    .reports()
    .map(({ id, agent, sessionId, kind }) => `${kind}:${agent}:${sessionId}:${id.slice(0, 4)}`)

for (const agent of agentNames)
  describe(`the report log of the ${agent} session`, () => {
    it("is written with the entry it comes with, in one save", () => {
      const records = memoryInbox()
      const saved = vi.spyOn(records, "saveEntry")
      const run = setup(records)
      run.open("t1", agent, "s1")
      const id = run.say("t1", "done", "Fixed it", "PR https://github.com/o/r/pull/9")
      expect(saved).toHaveBeenCalledWith(
        expect.objectContaining({ id }),
        expect.objectContaining({
          row: expect.objectContaining({
            id,
            agent,
            sessionId: "s1",
            terminalId: "t1",
            kind: "done",
            subject: "Fixed it",
            pr: "https://github.com/o/r/pull/9",
          }),
          body: "PR https://github.com/o/r/pull/9",
        }),
      )
      expect(records.reports()).toHaveLength(1)
    })

    it("outlives the Inbox's row: read, and a day later, the done is still the session's", () => {
      const records = memoryInbox()
      const run = setup(records)
      run.open("t1", agent, "s1")
      const id = run.say("t1", "done", "Fixed it")
      run.inbox.read([id])
      run.advance(retentionMs + 60 * 60_000)
      run.inbox.prune()
      // The Inbox let the entry go, with no exemption for a terminal's latest done.
      expect(records.entries()).toEqual([])
      expect(run.inbox.reports("t1").done).toEqual({ subject: "Fixed it", at: 1_007_000 })
      expect(run.inbox.happenings("t1")).toMatchObject([{ kind: "done", subject: "Fixed it" }])
      const stands = standingDone(run.inbox.reports("t1"), undefined, null)
      expect(stands?.subject).toBe("Fixed it")
    })

    it("is read by a terminal restored from History, which resumes the same session", () => {
      // History keeps the closed terminal, so its session's rows stay.
      const run = setup(memoryInbox(), { keeps: () => (row) => row.terminalId === "old" })
      run.open("old", agent, "s1")
      run.say("old", "done", "First task")
      run.say("old", "tell", "Half way")
      run.inbox.recordTurn(run.owners.get("old")!, run.now() + 1, turnFields())
      run.close("old")
      // A new terminal id resumes the session.
      run.open("restored", agent, "s1")
      expect(run.inbox.reports("restored")).toMatchObject({
        tell: { subject: "Half way" },
        done: { subject: "First task" },
      })
      expect(run.inbox.happenings("restored").map(({ kind }) => kind)).toEqual([
        "done",
        "update",
        "turn",
      ])
      // Another session in it reads none of that.
      run.open("restored", agent, "s2")
      expect(run.inbox.happenings("restored")).toEqual([])
    })

    it("keeps about 50 reports and asks, and the latest 10 turns, of a session", () => {
      const records = memoryInbox()
      const run = setup(records)
      const owner = run.open("t1", agent, "s1")
      for (let index = 1; index <= keptReports + 3; index += 1)
        run.inbox.read([run.say("t1", "done", `Done ${index}`)])
      for (let at = 1; at <= keptTurns + 2; at += 1) run.inbox.recordTurn(owner, at, turnFields())
      const kept = records.reports()
      expect(kept.filter(({ kind }) => kind === "done")).toHaveLength(keptReports)
      expect(kept.filter(({ kind }) => kind === "turn").map(({ at }) => at)).toEqual(
        Array.from({ length: keptTurns }, (_, index) => index + 3),
      )
      expect(run.inbox.reports("t1").done?.subject).toBe(`Done ${keptReports + 3}`)
      // Another session's rows are not counted against it.
      run.open("t2", agent, "s2")
      run.say("t2", "done", "Other")
      expect(records.reports().filter(({ kind }) => kind === "done")).toHaveLength(keptReports + 1)
    })

    it("reads a report's body from the store only when the report is asked to read it", () => {
      const records = memoryInbox()
      const bodies = vi.spyOn(records, "reportBodies")
      const run = setup(records)
      run.open("t1", agent, "s1")
      const id = run.say("t1", "done", "Fixed it", "At great length")
      run.inbox.recordTurn(run.owners.get("t1")!, 5, turnFields())
      expect(run.inbox.happenings("t1")).toMatchObject([
        { kind: "turn" },
        { kind: "done", body: null },
      ])
      expect(bodies).not.toHaveBeenCalled()
      const [, done] = run.inbox.happenings("t1", undefined, true)
      expect(bodies).not.toHaveBeenCalled()
      expect(done?.kind === "done" && done.read?.()).toBe("At great length")
      expect(bodies).toHaveBeenCalledTimes(1)
      expect(bodies).toHaveBeenCalledWith([id])
    })

    it("is loaded again by a new Inbox over the same records, and leaves another build's agent alone", () => {
      const records = memoryInbox()
      const run = setup(records)
      run.open("t1", agent, "s1")
      run.say("t1", "done", "Before the restart")
      records.saveReports([
        {
          row: {
            id: "future",
            projectId,
            terminalId: "t1",
            agent: "someday" as AgentName,
            sessionId: "s1",
            kind: "done",
            at: 1,
            from: null,
            subject: "A newer build's",
            outcome: null,
            text: null,
            pr: null,
          },
          body: null,
        },
      ])
      const next = setup(records)
      next.open("t1", agent, "s1")
      expect(next.inbox.happenings("t1").map(({ kind }) => kind)).toEqual(["done"])
      expect(records.reports().map(({ id }) => id)).toContain("future")
    })
  })

for (const agent of agentNames)
  describe(`the turns of the ${agent} session in the report log`, () => {
    it("stay when the person reads them, are amended after, and go when they were no turn", () => {
      const records = memoryInbox()
      const run = setup(records)
      const owner = run.open("t1", agent, "s1")
      run.inbox.recordTurn(owner, 5, turnFields("One."), 2)
      run.inbox.recordTurn(owner, 8, turnFields("Two."), 6)
      run.inbox.read(run.inbox.list().map(({ id }) => id))
      expect(run.inbox.list()).toEqual([])
      expect(run.inbox.happenings("t1")).toEqual([
        { kind: "turn", at: 5, from: 2, outcome: "completed", text: "One." },
        { kind: "turn", at: 8, from: 6, outcome: "completed", text: "Two." },
      ])
      // The end turned out to be a failure: its row changes though its entry is gone.
      run.inbox.amendTurn("t1", 8, {
        outcome: "failed",
        reply: null,
        error: "API error",
        files: [],
      })
      expect(run.inbox.happenings("t1").at(-1)).toEqual({
        kind: "turn",
        at: 8,
        from: 6,
        outcome: "failed",
        text: "API error",
      })
      expect(records.reports().find(({ at }) => at === 8)).toMatchObject({
        outcome: "failed",
        text: "API error",
      })
      // Or an interruption: its row goes, in the store too.
      run.inbox.amendTurn("t1", 5, null)
      expect(run.inbox.happenings("t1")).toHaveLength(1)
      expect(records.reports()).toHaveLength(1)
    })

    it("hold one row for an end stored again, keeping its start", () => {
      const records = memoryInbox()
      const run = setup(records)
      const owner = run.open("t1", agent, "s1")
      run.inbox.recordTurn(owner, 5, turnFields("One."), 2)
      run.inbox.read(run.inbox.list().map(({ id }) => id))
      run.inbox.recordTurn(owner, 5, turnFields("Again."))
      expect(records.reports()).toHaveLength(1)
      expect(run.inbox.happenings("t1")).toEqual([
        { kind: "turn", at: 5, from: 2, outcome: "completed", text: "Again." },
      ])
    })
  })

for (const agent of agentNames)
  describe(`the report log when the ${agent} session root is a guess`, () => {
    // Antigravity names its root only once its status line does, so the first is a guess;
    // the others never guess, but a correction moves what was made under one the same way.
    const guess = {
      type: "new" as const,
      root: { agent, sessionId: "tentative", instance: null, source: "binding" as const },
      guess: true,
      ready: true,
    }
    const correction = (confirmed = true) => ({
      type: "corrected" as const,
      from: "tentative",
      root: { ...guess.root, sessionId: "real", source: "status-line" as const },
      confirmed,
    })

    it("moves what was made while the guess stood to the session a correction names", () => {
      const records = memoryInbox()
      const run = setup(records)
      const owner = run.open("t1", agent, "tentative")
      const own = run.say("t1", "tell", "Its own, before the guess")
      run.advance(10_000)
      run.inbox.rooted("t1", [guess])
      const asked = run.inbox.call("t1", "ask", { subject: "Which?", body: "A or B" })
      if (!asked.ok) throw new Error(asked.reason)
      const tell = run.say("t1", "tell", "Under the guess")
      const done = run.say("t1", "done", "Fixed it")
      run.inbox.recordTurn(owner, run.now() + 1, turnFields())
      run.owners.set("t1", { ...owner, sessionId: "real" })
      run.inbox.rooted("t1", [correction()])
      const where = (id: string) => records.reports().find((row) => row.id === id)?.sessionId
      expect(where(own)).toBe("tentative")
      expect([tell, done, asked.id].map(where)).toEqual(["real", "real", "real"])
      expect(
        records
          .reports()
          .filter(({ kind }) => kind === "turn")
          .map(({ sessionId }) => sessionId),
      ).toEqual(["real"])
      expect(run.inbox.reports("t1")).toMatchObject({
        tell: { subject: "Under the guess" },
        done: { subject: "Fixed it" },
      })
      expect(run.inbox.happenings("t1").map(({ kind }) => kind)).toEqual([
        "asked",
        "update",
        "done",
        "turn",
      ])
    })

    it("moves the asks made while the guess stood, though they were answered, withdrawn or gone since", () => {
      const records = memoryInbox()
      const run = setup(records)
      const owner = run.open("t1", agent, "tentative")
      run.inbox.rooted("t1", [guess])
      const ask = (subject: string) => {
        run.advance(spacing)
        const made = run.inbox.call("t1", "ask", { subject, body: "Body" })
        if (!made.ok) throw new Error(made.reason)
        return made.id
      }
      const [withdrawn, kept] = [ask("Withdrawn"), ask("Open")]
      run.inbox.call("t1", "ask", { withdraw: withdrawn })
      run.advance(retentionMs + 1)
      run.inbox.prune()
      run.owners.set("t1", { ...owner, sessionId: "real" })
      run.inbox.rooted("t1", [correction()])
      const where = (id: string) => records.reports().find((row) => row.id === id)?.sessionId
      expect([where(withdrawn), where(kept)]).toEqual(["real", "real"])
    })

    it("moves reports whose Inbox rows are long gone, which only the log still holds", () => {
      const records = memoryInbox()
      const run = setup(records)
      const owner = run.open("t1", agent, "tentative")
      run.inbox.rooted("t1", [guess])
      const done = run.say("t1", "done", "Fixed it")
      run.inbox.read([done])
      run.advance(retentionMs + 1)
      run.inbox.prune()
      expect(records.entries()).toEqual([])
      run.owners.set("t1", { ...owner, sessionId: "real" })
      run.inbox.rooted("t1", [correction()])
      expect(records.reports().map(({ sessionId }) => sessionId)).toEqual(["real"])
      expect(run.inbox.reports("t1").done?.subject).toBe("Fixed it")
    })
  })

describe("which rows of the report log a closed terminal leaves", () => {
  it("drops a terminal's rows at its close when History keeps nothing of it", async () => {
    const records = memoryInbox()
    const run = setup(records)
    run.open("t1", "claude", "s1")
    run.say("t1", "done", "Fixed it")
    run.open("t2", "codex", "s2")
    run.say("t2", "done", "Other")
    run.close("t1")
    await Promise.resolve()
    expect(sessions(records)).toEqual([expect.stringMatching(/^done:codex:s2:/)])
    expect(run.inbox.reports("t1").done).toBeNull()
  })

  it("keeps them while History keeps the closed terminal, and drops them once its row is gone", async () => {
    const records = memoryInbox()
    const history = new Set<string>()
    const run = setup(records, { keeps: () => (row) => history.has(row.terminalId) })
    run.open("t1", "claude", "s1")
    run.say("t1", "done", "Fixed it")
    history.add("t1")
    run.close("t1")
    await Promise.resolve()
    expect(records.reports()).toHaveLength(1)
    // Restored in a new terminal, the session finds them.
    run.open("t2", "claude", "s1")
    expect(run.inbox.reports("t2").done?.subject).toBe("Fixed it")
    // Thirty days on, History's row is pruned and nothing holds the session.
    history.delete("t1")
    run.inbox.sweepLog()
    expect(records.reports()).toEqual([])
    expect(run.inbox.reports("t2").done).toBeNull()
  })

  it("keeps a session's rows while another terminal holds the session, whoever made them", async () => {
    const records = memoryInbox()
    const held = new Set<string>()
    const run = setup(records, { keeps: () => (row) => held.has(row.sessionId) })
    run.open("t1", "claude", "s1")
    run.say("t1", "done", "Fixed it")
    held.add("s1")
    run.close("t1")
    await Promise.resolve()
    expect(records.reports()).toHaveLength(1)
    held.clear()
    run.inbox.sweepLog()
    expect(records.reports()).toEqual([])
  })

  it("sweeps by itself now and then, as History's own rows pass", async ({ resources }) => {
    vi.useFakeTimers()
    resources.defer(() => void vi.useRealTimers())
    const records = memoryInbox()
    const history = new Set(["t1"])
    let at = 1_000_000
    const inbox = new Inbox(
      {
        owner: () => ({
          terminalId: "t1",
          projectId,
          workspaceSessionId,
          handle: "moth",
          agent: "claude",
          sessionId: "s1",
        }),
        reply: () => {},
        replyState: () => undefined,
        forgetReplies: () => {},
        changed: () => {},
        exists: () => false,
        keeps: () => (row) => history.has(row.terminalId),
      },
      records,
      () => at,
      { sweepMs: 1_000, logSweepMs: 5_000 },
    )
    resources.defer(() => inbox.close())
    inbox.call("t1", "done", { subject: "Fixed it", body: "Body" })
    // The first look, which History's row passes.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(records.reports()).toHaveLength(1)
    history.clear()
    at += 2_000
    await vi.advanceTimersByTimeAsync(1_000)
    // Too soon after its last look.
    expect(records.reports()).toHaveLength(1)
    at += 10_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(records.reports()).toEqual([])
  })

  it("sweeps once for any number of closes in a tick, and after the close is over", async () => {
    const records = memoryInbox()
    const keeps = vi.fn<() => undefined>(() => undefined)
    const run = setup(records, { keeps })
    for (const id of ["a", "b", "c"]) run.open(id, "claude", id)
    for (const id of ["a", "b", "c"]) run.close(id)
    run.inbox.reconcile("a")
    expect(keeps).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(keeps).toHaveBeenCalledTimes(1)
  })

  it("drops nothing where the runner can't tell what is held, and a failed read stops no close", async () => {
    const records = memoryInbox()
    let tell: "unknown" | "throws" | "known" = "unknown"
    const run = setup(records, {
      keeps: () => {
        if (tell === "throws") throw new Error("disk read failed")
        return tell === "unknown" ? undefined : () => false
      },
    })
    run.open("t1", "claude", "s1")
    run.say("t1", "done", "Fixed it")
    run.close("t1")
    await Promise.resolve()
    expect(records.reports()).toHaveLength(1)
    tell = "throws"
    expect(() => run.inbox.reconcile("t1")).not.toThrow()
    run.inbox.sweepLog()
    expect(records.reports()).toHaveLength(1)
    tell = "known"
    run.inbox.sweepLog()
    expect(records.reports()).toEqual([])
  })

  it("goes with a removed project", () => {
    const records = memoryInbox()
    const run = setup(records)
    run.open("t1", "claude", "s1")
    run.say("t1", "done", "Fixed it")
    run.inbox.forgetProject(projectId)
    expect(records.reports()).toEqual([])
    expect(run.inbox.reports("t1").done).toBeNull()
  })
})

describe("the report log in the workspace store", () => {
  it("saves a report with its entry, and a restart reads both, a turn included", ({
    resources,
  }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-report-log-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const path = join(folder, "workspace.sqlite")
    const store = storeWith(path, { projectId, sessionId: workspaceSessionId })
    const run = setup(store)
    const owner = run.open("t1", "agy", "s1")
    run.say("t1", "done", "Fixed it", "At length: https://github.com/o/r/pull/4")
    run.inbox.recordTurn(owner, 5, turnFields("Reply."), 3)
    run.inbox.close()
    store.close()
    const reopened = storeWith(path, { projectId, sessionId: workspaceSessionId })
    resources.defer(() => reopened.close())
    const next = setup(reopened)
    next.open("t1", "agy", "s1")
    const [turn, done] = next.inbox.happenings("t1", undefined, true)
    expect(turn).toEqual({ kind: "turn", at: 5, from: 3, outcome: "completed", text: "Reply." })
    expect(done).toMatchObject({
      kind: "done",
      at: 1_007_000,
      subject: "Fixed it",
      pr: "https://github.com/o/r/pull/4",
    })
    expect(done?.kind === "done" && done.read?.()).toBe("At length: https://github.com/o/r/pull/4")
  })
})
