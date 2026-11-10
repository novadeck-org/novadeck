import type { Work } from "@novadeck/protocol"
import type { WorkWatchItem } from "@novadeck/runner-client"
import { WireError } from "@novadeck/wire"
import { vi } from "vitest"

import { describe, expect, it } from "./test"
import { channel } from "./testing/channel"
import { id } from "./testing/scripted"
import { createRunnerWorks } from "./works"

const work = (n: number, change: Partial<Work> = {}): Work => ({
  terminalId: id(n),
  projectId: "p",
  root: `/shop/${n}`,
  branch: "feature",
  base: "origin/main",
  firstSeenAt: n * 1_000,
  added: 3,
  removed: 1,
  unreadAdded: 3,
  unreadRemoved: 1,
  files: [],
  truncated: false,
  conflicts: [],
  ...change,
})

const followed = (calls: { look?: (id: string) => Promise<void> } = {}) => {
  const stream = channel<WorkWatchItem>()
  const shown: string[] = []
  let watches = 0
  const { works, stop } = createRunnerWorks({
    watch: () => ((watches += 1), stream.iterator),
    look: calls.look ?? (async () => {}),
    show: async (terminalId) => (shown.push(terminalId), { itemId: `item-${terminalId}` }),
  })
  const release = works.watch()
  const ids = () =>
    works.state
      .getSnapshot()
      .works.map((each) => each.terminalId)
      .toSorted()
  return { works, stream, stop, release, ids, shown, watches: () => watches }
}

describe("Works, as the runner reports them", () => {
  it("shows the works once the first sequence is synced", async () => {
    const { stream, ids } = followed()
    stream.push({ type: "reset" })
    stream.push({ type: "changed", work: work(1) })
    expect(ids()).toEqual([])
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(ids()).toEqual([id(1)]))
  })

  it("follows later changes, and forgets what a new sequence doesn't report", async () => {
    const { works, stream, ids } = followed()
    stream.push({ type: "reset" })
    stream.push({ type: "changed", work: work(1) })
    stream.push({ type: "changed", work: work(2) })
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(ids()).toEqual([id(1), id(2)]))
    stream.push({ type: "changed", work: work(1, { unreadAdded: 0, unreadRemoved: 0 }) })
    await vi.waitFor(() =>
      expect(works.state.getSnapshot().works.find((each) => each.terminalId === id(1))).toEqual(
        expect.objectContaining({ unreadAdded: 0 }),
      ),
    )
    stream.push({ type: "removed", terminalId: id(2), projectId: "p" })
    await vi.waitFor(() => expect(ids()).toEqual([id(1)]))
    // After a reconnection: work 1 is no more, work 4 is new; until `synced` nothing changes.
    stream.push({ type: "reset" })
    stream.push({ type: "changed", work: work(4) })
    expect(ids()).toEqual([id(1)])
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(ids()).toEqual([id(4)]))
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
      look: async () => {},
      show: async () => ({ itemId: "x" }),
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

describe("looking at and showing a work", () => {
  it("tells the runner the terminal's work was read, without waiting", async () => {
    const looked: string[] = []
    const { works } = followed({ look: async (terminalId) => void looked.push(terminalId) })
    works.look(id(1))
    await vi.waitFor(() => expect(looked).toEqual([id(1)]))
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
    works.look(id(1))
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
      gone.works.look(id(1))
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(quiet).not.toHaveBeenCalled()
      const broken = followed({ look: () => Promise.reject(new Error("offline")) })
      broken.works.look(id(1))
      await vi.waitFor(() => expect(quiet).toHaveBeenCalledOnce())
    } finally {
      quiet.mockRestore()
    }
  })

  it("resolves a show to the item's id", async () => {
    const { works, shown } = followed()
    expect(await works.show(id(2))).toBe(`item-${id(2)}`)
    expect(shown).toEqual([id(2)])
  })
})
