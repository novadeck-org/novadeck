import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { storeWith } from "../testing/workspace.js"
import {
  Inbox,
  maxUnreadTurns,
  memoryInbox,
  type InboxRecords,
  type StoredEntry,
  type TurnFields,
  type TurnOwner,
} from "./inbox.js"

const owner: TurnOwner = {
  terminalId: randomUUID(),
  projectId: randomUUID(),
  workspaceSessionId: randomUUID(),
  handle: "moth",
  agent: "claude",
  sessionId: "first",
}
const fields = (reply: string | null = "All done."): TurnFields => ({
  outcome: "completed",
  reply,
  error: null,
  files: [],
})

const setup = (records: InboxRecords = memoryInbox(), now = () => 1000) => {
  let kept = true
  const changed = vi.fn<(terminalId: string) => void>()
  const inbox = new Inbox(
    {
      owner: () => owner,
      reply: () => {
        throw new Error("no reply")
      },
      replyState: () => undefined,
      forgetReplies: () => {},
      changed,
      exists: () => kept,
    },
    records,
    now,
    { sweepMs: 0 },
  )
  return {
    inbox,
    changed,
    forget: () => {
      kept = false
    },
    turns: () => inbox.list().filter((entry) => entry.content.kind === "turn"),
  }
}

describe("finished turns in Inbox", () => {
  it("lists a turn while its terminal exists, and reconcile removes it with the terminal", () => {
    const run = setup()
    run.inbox.recordTurn(owner, 5, fields())
    expect(run.turns()).toMatchObject([{ at: 5, content: { kind: "turn", reply: "All done." } }])
    run.forget()
    expect(run.inbox.list()).toEqual([])
    run.inbox.reconcile(owner.terminalId)
    expect(run.inbox.list()).toEqual([])
  })

  it("keeps turns out of the Messages history", () => {
    const run = setup()
    run.inbox.recordTurn(owner, 5, fields())
    const listing = {
      terminalId: owner.terminalId,
      handle: owner.handle,
      paused: false,
      threads: [],
    } as unknown as Parameters<typeof run.inbox.history>[1]
    expect(run.inbox.history(owner.terminalId, listing).threads).toEqual([])
  })

  it("updates one end in place and writes nothing for a no-op", () => {
    const records = memoryInbox()
    const saved = vi.spyOn(records, "saveEntry")
    const run = setup(records)
    run.inbox.recordTurn(owner, 5, fields("One."))
    const [first] = run.turns()
    expect(saved).toHaveBeenCalledTimes(1)
    run.inbox.recordTurn(owner, 5, fields("One."))
    run.inbox.amendTurn(owner.terminalId, 5, fields("One."))
    expect(saved).toHaveBeenCalledTimes(1)
    run.inbox.amendTurn(owner.terminalId, 5, fields("Two."))
    expect(run.turns()).toMatchObject([{ id: first!.id, content: { reply: "Two." } }])
    run.inbox.amendTurn(owner.terminalId, 5, null)
    expect(run.turns()).toEqual([])
    // An amend of an end that is not stored stores nothing.
    run.inbox.amendTurn(owner.terminalId, 5, fields())
    expect(run.turns()).toEqual([])
  })

  it("keeps at most 50 unread turns per terminal, dropping the oldest", () => {
    const run = setup()
    for (let at = 1; at <= maxUnreadTurns + 1; at += 1) run.inbox.recordTurn(owner, at, fields())
    const ats = run.turns().map((entry) => entry.at)
    expect(ats).toHaveLength(maxUnreadTurns)
    expect(ats).not.toContain(1)
    expect(ats).toContain(maxUnreadTurns + 1)
  })

  it("sends no message change for a change to turns alone", () => {
    const run = setup()
    run.inbox.recordTurn(owner, 5, fields())
    run.inbox.recordTurn(owner, 5, fields("Two."))
    run.inbox.amendTurn(owner.terminalId, 5, null)
    run.inbox.recordTurn(owner, 6, fields())
    run.inbox.read(run.turns().map(({ id }) => id))
    expect(run.changed).not.toHaveBeenCalled()
  })

  it("reads turns and tells in one batch: turns go, tells stay as history, one listing", async () => {
    const records = memoryInbox()
    const removed = vi.spyOn(records, "removeEntries")
    const savedMany = vi.spyOn(records, "saveEntries")
    const run = setup(records)
    const told = run.inbox.call(owner.terminalId, "tell", { subject: "FYI", body: "Body" })
    if (!told.ok) throw new Error(told.reason)
    run.inbox.recordTurn(owner, 5, fields())
    run.inbox.recordTurn(owner, 6, fields())
    const watch = run.inbox.watch()
    await watch.next()
    const ids = [...run.turns().map(({ id }) => id), told.id, randomUUID()]
    removed.mockClear()
    savedMany.mockClear()
    const listing = watch.next()
    run.inbox.read(ids)
    expect((await listing).value).toEqual([])
    expect(removed).toHaveBeenCalledTimes(1)
    expect(savedMany).toHaveBeenCalledTimes(1)
    expect(records.entries().filter((entry) => entry.content.kind === "tell")).toMatchObject([
      { state: "read" },
    ])
    expect(records.entries().filter((entry) => entry.content.kind === "turn")).toEqual([])
    await watch.return(undefined)
  })

  it("stores nothing once closed", () => {
    const run = setup()
    run.inbox.close()
    run.inbox.recordTurn(owner, 5, fields())
    expect(run.turns()).toEqual([])
    expect(run.inbox.accepts(owner.terminalId)).toBe(false)
  })
})

describe("finished turns across a restart", () => {
  const stored = (content: unknown): StoredEntry =>
    ({
      id: randomUUID(),
      ...owner,
      at: 7,
      state: "open",
      content,
    }) as StoredEntry

  it("loads a turn stored with the gist an older runner wrote, without it", () => {
    const records = memoryInbox()
    records.saveEntry(
      stored({
        kind: "turn",
        outcome: "completed",
        reply: "All done.",
        gist: "Fixed the build",
        error: null,
        files: [],
      }),
    )
    const run = setup(records)
    expect(run.turns()).toHaveLength(1)
    expect(run.turns()[0]!.content).toEqual({
      kind: "turn",
      outcome: "completed",
      reply: "All done.",
      error: null,
      files: [],
    })
  })

  it("clamps a turn stored under looser rules, with a pinned fixture", () => {
    const records = memoryInbox()
    // Stored by a runner with other limits: a long reply, 20 files, an unknown key and outcome.
    records.saveEntry(
      stored({
        kind: "turn",
        outcome: "interrupted",
        reply: "r".repeat(300),
        gist: "Fixed the build",
        error: "e".repeat(5000),
        files: Array.from({ length: 20 }, (_, index) => `/f${index}`),
        later: "a key from a newer runner",
      }),
    )
    records.saveEntry(stored("not even an object"))
    const run = setup(records)
    expect(run.turns()).toHaveLength(1)
    expect(run.turns()[0]!.content).toEqual({
      kind: "turn",
      outcome: "failed",
      reply: "r".repeat(120),
      error: "e".repeat(2048),
      files: Array.from({ length: 16 }, (_, index) => `/f${index}`),
    })
    // Clamped in memory only: the records keep what a newer runner wrote, and the unreadable
    // entry, with no content at all, is dropped without stopping Inbox from starting.
    expect(records.entries()).toHaveLength(1)
    expect(records.entries()[0]!.content).toHaveProperty("later")
  })

  it("drops a stored entry with no content and still constructs", () => {
    const records = memoryInbox()
    records.saveEntry(stored(undefined))
    records.saveEntry(stored(null))
    const run = setup(records)
    expect(run.inbox.list()).toEqual([])
    expect(records.entries()).toEqual([])
  })

  it("looks a terminal up once per listing", () => {
    const lookups = vi.fn<(terminalId: string) => boolean>(() => true)
    const inbox = new Inbox(
      {
        owner: () => owner,
        reply: () => {},
        replyState: () => undefined,
        forgetReplies: () => {},
        changed: () => {},
        exists: lookups,
      },
      memoryInbox(),
      () => 1000,
      { sweepMs: 0 },
    )
    for (let at = 1; at <= 5; at += 1) inbox.recordTurn(owner, at, fields())
    lookups.mockClear()
    expect(inbox.list()).toHaveLength(5)
    expect(lookups).toHaveBeenCalledTimes(1)
    lookups.mockClear()
    inbox.prune()
    expect(lookups.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it("lists turns saved through the workspace store again for a new Inbox over it", ({
    resources,
  }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-turns-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const store = storeWith(join(folder, "workspace.sqlite"), owner)
    resources.defer(() => store.close())
    const first = setup(store)
    first.inbox.recordTurn(owner, 5, fields("Before the restart."))
    first.inbox.recordTurn(owner, 6, { ...fields(), outcome: "failed", error: "boom" })
    first.inbox.close()
    const second = setup(store)
    expect(second.turns().map((entry) => entry.content)).toMatchObject([
      { outcome: "completed", reply: "Before the restart." },
      { outcome: "failed", error: "boom" },
    ])
    second.inbox.read([second.turns()[0]!.id])
    expect(setup(store).turns()).toHaveLength(1)
  })
})
