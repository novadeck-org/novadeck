import type { Work, WorkClosing, WorkMade } from "@novadeck/protocol"
import type { WorkWatchItem } from "@novadeck/runner-client"
import { WireError } from "@novadeck/wire"
import { vi } from "vitest"

import { describe, expect, it } from "./test"
import { channel } from "./testing/channel"
import { id } from "./testing/scripted"
import { createRunnerWorks } from "./works"

const root = (n: number) => `/shop/${n}`

const work = (n: number, change: Partial<Work> = {}): Work => ({
  root: root(n),
  terminalId: id(n),
  projectId: "p",
  working: false,
  branch: "feature",
  base: "origin/main",
  firstSeenAt: n * 1_000,
  merged: false,
  added: 3,
  removed: 1,
  unreadAdded: 3,
  unreadRemoved: 1,
  files: [],
  truncated: false,
  conflicts: [],
  ...change,
})

const followed = (
  calls: {
    look?: (root: string) => Promise<void>
    close?: (root: string, force?: boolean) => Promise<WorkClosing>
  } = {},
) => {
  const stream = channel<WorkWatchItem>()
  const made = channel<WorkMade>()
  const shown: string[] = []
  let watches = 0
  const { works, stop } = createRunnerWorks({
    watch: () => ((watches += 1), stream.iterator),
    made: () => made.iterator,
    look: calls.look ?? (async () => {}),
    show: async (at, terminalId) => (
      shown.push(terminalId === undefined ? at : `${at} on ${terminalId}`),
      { itemId: `item-${at}` }
    ),
    close: calls.close ?? (async () => ({ closed: true as const, branchDeleted: false })),
  })
  const release = works.watch()
  const ids = () =>
    works.state
      .getSnapshot()
      .works.map((each) => each.root)
      .toSorted()
  return { works, stream, made, stop, release, ids, shown, watches: () => watches }
}

describe("Works, as the runner reports them", () => {
  it("shows the works once the first sequence is synced", async () => {
    const { stream, ids } = followed()
    stream.push({ type: "reset" })
    stream.push({ type: "changed", work: work(1) })
    expect(ids()).toEqual([])
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(ids()).toEqual([root(1)]))
  })

  it("keeps works by root: one with no owner, and two of one owner", async () => {
    const { works, stream, ids } = followed()
    stream.push({ type: "reset" })
    stream.push({ type: "changed", work: work(1, { terminalId: null }) })
    stream.push({ type: "changed", work: work(2, { terminalId: id(9) }) })
    stream.push({ type: "changed", work: work(3, { terminalId: id(9) }) })
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(ids()).toEqual([root(1), root(2), root(3)]))
    expect(works.state.getSnapshot().works.find((each) => each.root === root(1))?.terminalId).toBe(
      null,
    )
  })

  it("follows later changes, and forgets what a new sequence doesn't report", async () => {
    const { works, stream, ids } = followed()
    stream.push({ type: "reset" })
    stream.push({ type: "changed", work: work(1) })
    stream.push({ type: "changed", work: work(2) })
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(ids()).toEqual([root(1), root(2)]))
    stream.push({ type: "changed", work: work(1, { unreadAdded: 0, unreadRemoved: 0 }) })
    await vi.waitFor(() =>
      expect(works.state.getSnapshot().works.find((each) => each.root === root(1))).toEqual(
        expect.objectContaining({ unreadAdded: 0 }),
      ),
    )
    stream.push({ type: "removed", root: root(2), projectId: "p" })
    await vi.waitFor(() => expect(ids()).toEqual([root(1)]))
    // After a reconnection: work 1 is no more, work 4 is new; until `synced` nothing changes.
    stream.push({ type: "reset" })
    stream.push({ type: "changed", work: work(4) })
    expect(ids()).toEqual([root(1)])
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(ids()).toEqual([root(4)]))
  })

  it("is synced once the first sequence is, and not after the last watcher lets go", async () => {
    const { works, stream, release } = followed()
    expect(works.state.getSnapshot().synced).toBe(false)
    stream.push({ type: "reset" })
    stream.push({ type: "changed", work: work(1) })
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(works.state.getSnapshot().synced).toBe(true))
    release()
    expect(works.state.getSnapshot().synced).toBe(false)
    // What was last reported stays.
    expect(works.state.getSnapshot().works).toHaveLength(1)
  })

  it("follows from the first watcher to the last release, and again when watched anew", async () => {
    const { works, stream, release, watches } = followed()
    expect(watches()).toBe(1)
    const second = works.watch()
    expect(watches()).toBe(1)
    release()
    release()
    expect(stream.returned()).toBe(0)
    second()
    await vi.waitFor(() => expect(stream.returned()).toBe(1))
    works.watch()
    expect(watches()).toBe(2)
  })

  it("does not follow at all until watched", () => {
    let watches = 0
    createRunnerWorks({
      watch: () => ((watches += 1), channel<WorkWatchItem>().iterator),
      made: () => channel<WorkMade>().iterator,
      look: async () => {},
      show: async () => ({ itemId: "x" }),
      close: async () => ({ closed: true as const, branchDeleted: false }),
    })
    expect(watches).toBe(0)
  })

  it("follows no more once the backend has stopped", () => {
    const { works, stop, watches } = followed()
    stop()
    works.watch()
    expect(watches()).toBe(1)
  })

  it("stops following when told to", async () => {
    const { stream, stop, ids } = followed()
    stream.push({ type: "reset" })
    stream.push({ type: "synced" })
    stop()
    stream.push({ type: "changed", work: work(1) })
    await vi.waitFor(() => expect(stream.returned()).toBe(1))
    expect(ids()).toEqual([])
  })
})

describe("reading the works once, as the backend starts", () => {
  const unwatched = () => {
    const stream = channel<WorkWatchItem>()
    let watches = 0
    const runner = createRunnerWorks({
      watch: () => ((watches += 1), stream.iterator),
      made: () => channel<WorkMade>().iterator,
      look: async () => {},
      show: async () => ({ itemId: "x" }),
      close: async () => ({ closed: true as const, branchDeleted: false }),
    })
    const state = () => runner.works.state.getSnapshot()
    return { ...runner, stream, state, watches: () => watches }
  }

  it("keeps the works the runner reported, and stops following once it has reported them all", async () => {
    const { readOnce, stream, state } = unwatched()
    expect(state().reported).toBe(false)
    readOnce()
    stream.push({ type: "reset" })
    stream.push({ type: "changed", work: work(1) })
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(stream.returned()).toBe(1))
    expect(state()).toEqual({ works: [work(1)], synced: false, reported: true })
  })

  it("leaves the following to a watcher that came meanwhile", async () => {
    const { works, readOnce, stream, state, watches } = unwatched()
    readOnce()
    const release = works.watch()
    expect(watches()).toBe(1)
    stream.push({ type: "reset" })
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(state().synced).toBe(true))
    expect(stream.returned()).toBe(0)
    release()
    await vi.waitFor(() => expect(stream.returned()).toBe(1))
  })

  it("reads them no more once they were reported, or the backend has stopped", async () => {
    const { readOnce, stream, state, watches, stop } = unwatched()
    readOnce()
    readOnce()
    expect(watches()).toBe(1)
    stream.push({ type: "reset" })
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(state().reported).toBe(true))
    readOnce()
    stop()
    readOnce()
    expect(watches()).toBe(1)
  })

  it("stays reported after a watcher lets go, though no longer synced", async () => {
    const { works, stream, state } = unwatched()
    const release = works.watch()
    stream.push({ type: "reset" })
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(state().synced).toBe(true))
    release()
    expect(state()).toEqual({ works: [], synced: false, reported: true })
  })
})

describe("looking at and showing a work", () => {
  it("tells the runner the terminal's work was read, without waiting", async () => {
    const looked: string[] = []
    const { works } = followed({ look: async (at) => void looked.push(at) })
    works.look(root(1))
    await vi.waitFor(() => expect(looked).toEqual([root(1)]))
  })

  it("reads the work at once, before the runner reports it again", async () => {
    const { works, stream } = followed({ look: () => new Promise(() => {}) })
    const file = {
      path: "src/a.ts",
      added: 3,
      removed: 1,
      unreadAdded: 3,
      unreadRemoved: 1,
      conflict: false,
    }
    stream.push({ type: "reset" })
    stream.push({ type: "changed", work: work(1, { files: [file] }) })
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(works.state.getSnapshot().works).toHaveLength(1))
    works.look(root(1))
    const [looked] = works.state.getSnapshot().works
    expect(looked).toEqual(expect.objectContaining({ unreadAdded: 0, unreadRemoved: 0, added: 3 }))
    expect(looked?.files).toEqual([{ ...file, unreadAdded: 0, unreadRemoved: 0 }])
  })

  it("lets a look at a work that is gone pass quietly, and reports any other failure", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const gone = followed({
        look: () => Promise.reject(new WireError("NOT_FOUND", "no work")),
      })
      gone.works.look(root(1))
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(quiet).not.toHaveBeenCalled()
      const broken = followed({ look: () => Promise.reject(new Error("offline")) })
      broken.works.look(root(1))
      await vi.waitFor(() => expect(quiet).toHaveBeenCalledOnce())
    } finally {
      quiet.mockRestore()
    }
  })

  it("resolves a show to the item's id", async () => {
    const { works, shown } = followed()
    expect(await works.show(root(2))).toBe(`item-${root(2)}`)
    expect(shown).toEqual([root(2)])
  })

  it("names the terminal to show a work with no owner on", async () => {
    const { works, shown } = followed()
    await works.show(root(3), id(7))
    expect(shown).toEqual([`${root(3)} on ${id(7)}`])
  })

  it("closes a worktree by its root and says what was kept, or passes the runner's refusal on", async () => {
    const closed: [string, boolean | undefined][] = []
    const { works } = followed({
      close: async (at, force) => {
        closed.push([at, force])
        if (!force) throw new WireError("CONFLICT", "The worktree holds 2 uncommitted files.")
        return { closed: true, kept: "refs/novadeck/kept/feature", branchDeleted: false }
      },
    })
    await expect(works.close(root(1))).rejects.toMatchObject({
      message: "The worktree holds 2 uncommitted files.",
    })
    expect(await works.close(root(1), true)).toEqual({
      closed: true,
      kept: "refs/novadeck/kept/feature",
      branchDeleted: false,
    })
    expect(closed).toEqual([
      [root(1), undefined],
      [root(1), true],
    ])
  })
})

describe("Worktrees made, as the runner reports them", () => {
  const newOne = (n: number): WorkMade => ({ root: root(n), projectId: "p" })
  const count = (works: { made?: { getSnapshot: () => number } | undefined }) =>
    works.made!.getSnapshot()

  it("counts each one, whether or not the works are watched", async () => {
    const { works, made, release } = followed()
    expect(count(works)).toBe(0)
    release()
    made.push(newOne(1))
    made.push(newOne(2))
    await vi.waitFor(() => expect(count(works)).toBe(2))
    expect(works.state.getSnapshot().works).toEqual([])
  })

  it("lets go of the stream for good with the backend", () => {
    const { made, stop } = followed()
    expect(made.returned()).toBe(0)
    stop()
    expect(made.returned()).toBe(1)
  })
})
