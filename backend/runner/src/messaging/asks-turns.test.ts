import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { WorkspaceStore } from "../workspaces/store.js"
import {
  Asks,
  maxUnreadTurns,
  memoryAsks,
  type AskRecords,
  type Letter,
  type TurnFields,
  type TurnOwner,
} from "./asks.js"

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

const setup = (records: AskRecords = memoryAsks(), now = () => 1000) => {
  let kept = true
  const changed = vi.fn<(terminalId: string) => void>()
  const asks = new Asks(
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
    asks,
    changed,
    forget: () => {
      kept = false
    },
    turns: () => asks.list().filter((letter) => letter.content.kind === "turn"),
  }
}

describe("finished turns in Asks", () => {
  it("lists a turn while its terminal exists, and reconcile removes it with the terminal", () => {
    const run = setup()
    run.asks.recordTurn(owner, 5, fields())
    expect(run.turns()).toMatchObject([{ at: 5, content: { kind: "turn", reply: "All done." } }])
    run.forget()
    expect(run.asks.list()).toEqual([])
    run.asks.reconcile(owner.terminalId)
    expect(run.asks.list()).toEqual([])
  })

  it("keeps turns out of the Messages history", () => {
    const run = setup()
    run.asks.recordTurn(owner, 5, fields())
    const listing = {
      terminalId: owner.terminalId,
      handle: owner.handle,
      paused: false,
      threads: [],
    } as unknown as Parameters<typeof run.asks.history>[1]
    expect(run.asks.history(owner.terminalId, listing).threads).toEqual([])
  })

  it("updates one end in place and writes nothing for a no-op", () => {
    const records = memoryAsks()
    const saved = vi.spyOn(records, "saveLetter")
    const run = setup(records)
    run.asks.recordTurn(owner, 5, fields("One."))
    const [first] = run.turns()
    expect(saved).toHaveBeenCalledTimes(1)
    run.asks.recordTurn(owner, 5, fields("One."))
    run.asks.amendTurn(owner.terminalId, 5, fields("One."))
    expect(saved).toHaveBeenCalledTimes(1)
    run.asks.amendTurn(owner.terminalId, 5, fields("Two."))
    expect(run.turns()).toMatchObject([{ id: first!.id, content: { reply: "Two." } }])
    run.asks.amendTurn(owner.terminalId, 5, null)
    expect(run.turns()).toEqual([])
    // An amend of an end that is not stored stores nothing.
    run.asks.amendTurn(owner.terminalId, 5, fields())
    expect(run.turns()).toEqual([])
  })

  it("keeps at most 50 unread turns per terminal, dropping the oldest", () => {
    const run = setup()
    for (let at = 1; at <= maxUnreadTurns + 1; at += 1) run.asks.recordTurn(owner, at, fields())
    const ats = run.turns().map((letter) => letter.at)
    expect(ats).toHaveLength(maxUnreadTurns)
    expect(ats).not.toContain(1)
    expect(ats).toContain(maxUnreadTurns + 1)
  })

  it("sends no mail change for a change to turns alone", () => {
    const run = setup()
    run.asks.recordTurn(owner, 5, fields())
    run.asks.recordTurn(owner, 5, fields("Two."))
    run.asks.amendTurn(owner.terminalId, 5, null)
    run.asks.recordTurn(owner, 6, fields())
    run.asks.read(run.turns().map(({ id }) => id))
    expect(run.changed).not.toHaveBeenCalled()
  })

  it("reads turns and tells in one batch: turns go, tells stay as history, one listing", async () => {
    const records = memoryAsks()
    const removed = vi.spyOn(records, "removeLetters")
    const savedMany = vi.spyOn(records, "saveLetters")
    const run = setup(records)
    const told = run.asks.call(owner.terminalId, "tell", { subject: "FYI", body: "Body" })
    if (!told.ok) throw new Error(told.reason)
    run.asks.recordTurn(owner, 5, fields())
    run.asks.recordTurn(owner, 6, fields())
    const watch = run.asks.watch()
    await watch.next()
    const ids = [...run.turns().map(({ id }) => id), told.id, randomUUID()]
    removed.mockClear()
    savedMany.mockClear()
    const listing = watch.next()
    run.asks.read(ids)
    expect((await listing).value).toEqual([])
    expect(removed).toHaveBeenCalledTimes(1)
    expect(savedMany).toHaveBeenCalledTimes(1)
    expect(records.letters().filter((letter) => letter.content.kind === "tell")).toMatchObject([
      { state: "read" },
    ])
    expect(records.letters().filter((letter) => letter.content.kind === "turn")).toEqual([])
    await watch.return(undefined)
  })

  it("stores nothing once closed", () => {
    const run = setup()
    run.asks.close()
    run.asks.recordTurn(owner, 5, fields())
    expect(run.turns()).toEqual([])
    expect(run.asks.accepts(owner.terminalId)).toBe(false)
  })
})

describe("finished turns across a restart", () => {
  const stored = (content: unknown): Letter =>
    ({
      id: randomUUID(),
      ...owner,
      at: 7,
      state: "open",
      content,
    }) as Letter

  it("loads a turn stored with the gist an older runner wrote, without it", () => {
    const records = memoryAsks()
    records.saveLetter(
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
    const records = memoryAsks()
    // Stored by a runner with other limits: a long reply, 20 files, an unknown key and outcome.
    records.saveLetter(
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
    records.saveLetter(stored("not even an object"))
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
    // letter, with no content at all, is dropped without stopping Asks from starting.
    expect(records.letters()).toHaveLength(1)
    expect(records.letters()[0]!.content).toHaveProperty("later")
  })

  it("drops a stored letter with no content and still constructs", () => {
    const records = memoryAsks()
    records.saveLetter(stored(undefined))
    records.saveLetter(stored(null))
    const run = setup(records)
    expect(run.asks.list()).toEqual([])
    expect(records.letters()).toEqual([])
  })

  it("looks a terminal up once per listing", () => {
    const lookups = vi.fn<(terminalId: string) => boolean>(() => true)
    const asks = new Asks(
      {
        owner: () => owner,
        reply: () => {},
        replyState: () => undefined,
        forgetReplies: () => {},
        changed: () => {},
        exists: lookups,
      },
      memoryAsks(),
      () => 1000,
      { sweepMs: 0 },
    )
    for (let at = 1; at <= 5; at += 1) asks.recordTurn(owner, at, fields())
    lookups.mockClear()
    expect(asks.list()).toHaveLength(5)
    expect(lookups).toHaveBeenCalledTimes(1)
    lookups.mockClear()
    asks.prune()
    expect(lookups.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it("lists turns saved through the workspace store again for a new Asks over it", ({
    resources,
  }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-turns-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const store = new WorkspaceStore(join(folder, "workspace.sqlite"))
    resources.defer(() => store.close())
    const first = setup(store)
    first.asks.recordTurn(owner, 5, fields("Before the restart."))
    first.asks.recordTurn(owner, 6, { ...fields(), outcome: "failed", error: "boom" })
    first.asks.close()
    const second = setup(store)
    expect(second.turns().map((letter) => letter.content)).toMatchObject([
      { outcome: "completed", reply: "Before the restart." },
      { outcome: "failed", error: "boom" },
    ])
    second.asks.read([second.turns()[0]!.id])
    expect(setup(store).turns()).toHaveLength(1)
  })
})
