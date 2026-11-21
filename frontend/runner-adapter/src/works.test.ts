import type { WorksMade } from "@novadeck/core/works"
import type { Work, WorkClosing, WorkMade, WorkPreview } from "@novadeck/protocol"
import type { WorkWatchItem } from "@novadeck/runner-client"
import { WireError } from "@novadeck/wire"
import { vi } from "vitest"

import { describe, expect, it } from "./test"
import { channel } from "./testing/channel"
import { id } from "./testing/scripted"
import { createRunnerWorks, worksBatchMs } from "./works"

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
    preview?: (projectId: string, path: string) => Promise<WorkPreview>
    fetch?: (projectId: string) => Promise<void>
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
    preview: calls.preview ?? (async () => ({ main: null, works: [], renames: [] })),
    fetch: calls.fetch ?? (async () => {}),
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

  it("publishes a poll's changes together, a moment after the first", async () => {
    vi.useFakeTimers()
    try {
      const { works, stream, ids } = followed()
      stream.push({ type: "reset" })
      stream.push({ type: "changed", work: work(1) })
      stream.push({ type: "changed", work: work(2) })
      stream.push({ type: "synced" })
      await vi.advanceTimersByTimeAsync(0)
      expect(ids()).toEqual([root(1), root(2)])
      let published = 0
      works.state.subscribe(() => (published += 1))
      stream.push({ type: "changed", work: work(1, { unreadAdded: 0 }) })
      stream.push({ type: "changed", work: work(3) })
      stream.push({ type: "removed", root: root(2), projectId: "p" })
      await vi.advanceTimersByTimeAsync(worksBatchMs - 1)
      expect(published).toBe(0)
      expect(ids()).toEqual([root(1), root(2)])
      await vi.advanceTimersByTimeAsync(1)
      expect(published).toBe(1)
      expect(ids()).toEqual([root(1), root(3)])
    } finally {
      vi.useRealTimers()
    }
  })

  it("publishes the changes still waiting at once as the following ends, or the works are read", async () => {
    vi.useFakeTimers()
    try {
      const { works, stream, ids, release } = followed()
      stream.push({ type: "reset" })
      stream.push({ type: "synced" })
      await vi.advanceTimersByTimeAsync(0)
      stream.push({ type: "changed", work: work(1) })
      await vi.advanceTimersByTimeAsync(0)
      // A look publishes what it reads with whatever waits.
      works.look(root(1))
      expect(ids()).toEqual([root(1)])
      stream.push({ type: "changed", work: work(2) })
      await vi.advanceTimersByTimeAsync(0)
      expect(ids()).toEqual([root(1)])
      release()
      expect(ids()).toEqual([root(1), root(2)])
      expect(works.state.getSnapshot().synced).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("publishes a change still waiting as the following ends, though nothing was synced", async () => {
    vi.useFakeTimers()
    try {
      const { stream, ids, release } = followed()
      stream.push({ type: "changed", work: work(1) })
      await vi.advanceTimersByTimeAsync(0)
      expect(ids()).toEqual([])
      release()
      expect(ids()).toEqual([root(1)])
    } finally {
      vi.useRealTimers()
    }
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
      preview: async () => ({ main: null, works: [], renames: [] }),
      fetch: async () => {},
    })
    expect(watches).toBe(0)
  })

  it("follows no more while the backend has stopped", () => {
    const { works, stop, watches } = followed()
    stop()
    works.watch()
    expect(watches()).toBe(1)
  })

  // StrictMode mounts the app twice, stopping the first backend run before the second starts,
  // and a reboot does the same: the works are followed on the second run too.
  it("follows again once the backend starts again, for the panels still watching", async () => {
    const first = channel<WorkWatchItem>()
    const second = channel<WorkWatchItem>()
    const streams = [first, second]
    let watches = 0
    const { works, readOnce, stop } = createRunnerWorks({
      watch: () => streams[watches++]!.iterator,
      made: () => channel<WorkMade>().iterator,
      look: async () => {},
      show: async () => ({ itemId: "x" }),
      close: async () => ({ closed: true as const, branchDeleted: false }),
      preview: async () => ({ main: null, works: [], renames: [] }),
      fetch: async () => {},
    })
    readOnce()
    stop()
    // The panel mounts, and watches, while the backend is between its runs.
    const release = works.watch()
    expect(watches).toBe(1)
    readOnce()
    expect(watches).toBe(2)
    second.push({ type: "reset" })
    second.push({ type: "changed", work: work(1) })
    second.push({ type: "synced" })
    await vi.waitFor(() =>
      expect(works.state.getSnapshot()).toEqual({ works: [work(1)], synced: true, reported: true }),
    )
    release()
    await vi.waitFor(() => expect(second.returned()).toBe(1))
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
      preview: async () => ({ main: null, works: [], renames: [] }),
      fetch: async () => {},
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

  it("reads them no more once they were reported", async () => {
    const { readOnce, stream, state, watches, stop } = unwatched()
    readOnce()
    readOnce()
    expect(watches()).toBe(1)
    stream.push({ type: "reset" })
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(state().reported).toBe(true))
    readOnce()
    expect(watches()).toBe(1)
    stop()
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
      status: "modified" as const,
      changedAt: 1,
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

  it("asks the runner what a project's file would be once its works merge", async () => {
    const asked: [string, string][] = []
    const preview = { main: "a\n", works: [], renames: [] }
    const { works } = followed({
      preview: async (project, path) => (asked.push([project, path]), preview),
    })
    expect(await works.preview("p", "src/a.ts")).toEqual(preview)
    expect(asked).toEqual([["p", "src/a.ts"]])
  })

  it("fetches a project's origins through the runner, and resolves when it has", async () => {
    const asked: string[] = []
    const { works } = followed({ fetch: async (project) => void asked.push(project) })
    await works.fetch?.("p")
    expect(asked).toEqual(["p"])
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
  const newOne = (n: number, projectId = "p"): WorkMade => ({ root: root(n), projectId })
  const count = (works: { made?: { getSnapshot: () => WorksMade } | undefined }, projectId = "p") =>
    works.made!.getSnapshot().get(projectId) ?? 0

  it("counts each one, whether or not the works are watched", async () => {
    const { works, made, release } = followed()
    expect(count(works)).toBe(0)
    release()
    made.push(newOne(1))
    made.push(newOne(2))
    await vi.waitFor(() => expect(count(works)).toBe(2))
    expect(works.state.getSnapshot().works).toEqual([])
  })

  it("counts them by project", async () => {
    const { works, made } = followed()
    made.push(newOne(1))
    made.push(newOne(2, "q"))
    made.push(newOne(3, "q"))
    await vi.waitFor(() => expect(count(works, "q")).toBe(2))
    expect(count(works, "p")).toBe(1)
    expect(count(works, "r")).toBe(0)
  })

  it("lets go of the stream with the backend", () => {
    const { made, stop } = followed()
    expect(made.returned()).toBe(0)
    stop()
    expect(made.returned()).toBe(1)
  })
})
