import type { ClosedTerminal } from "@novadeck/core/history"
import type { HistoryWatchItem } from "@novadeck/runner-client"
import { vi } from "vitest"

import { createRunnerHistory } from "./history"
import { describe, expect, it } from "./test"
import { channel } from "./testing/channel"
import { id, scripted } from "./testing/scripted"

const closed = (n: number, change: Partial<ClosedTerminal> = {}): ClosedTerminal => ({
  id: id(n),
  projectId: "p",
  title: `Terminal ${n}`,
  summary: null,
  handle: "moth",
  agent: null,
  program: null,
  cwd: "/tmp",
  closedAt: n * 1_000,
  closedBy: null,
  availability: { state: "ready" },
  ...change,
})

const followed = (listing: (projectId: string) => ClosedTerminal[] = () => []) => {
  const stream = channel<HistoryWatchItem>()
  const listed: string[] = []
  const { history, follow, stop } = createRunnerHistory({
    list: async ({ projectId }) => (listed.push(projectId), listing(projectId)),
    watch: () => stream.iterator,
  })
  follow()
  const ids = () => history.state.getSnapshot().rows.map((row) => row.id)
  return { history, stream, stop, ids, listed }
}

describe("History, as the runner reports it", () => {
  it("shows every closed terminal newest first once the first sequence is synced", async () => {
    const { stream, ids } = followed()
    stream.push({ type: "reset" })
    stream.push({ type: "changed", closed: closed(1) })
    stream.push({ type: "changed", closed: closed(3) })
    expect(ids()).toEqual([])
    stream.push({ type: "changed", closed: closed(2) })
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(ids()).toEqual([id(3), id(2), id(1)]))
  })

  it("follows later changes, and forgets what a new sequence doesn't report", async () => {
    const { history, stream, ids } = followed()
    stream.push({ type: "reset" })
    stream.push({ type: "changed", closed: closed(1) })
    stream.push({ type: "changed", closed: closed(2) })
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(ids()).toEqual([id(2), id(1)]))
    stream.push({ type: "changed", closed: closed(1, { availability: { state: "restoring" } }) })
    await vi.waitFor(() =>
      expect(history.state.getSnapshot().rows[1]?.availability).toEqual({ state: "restoring" }),
    )
    stream.push({ type: "removed", id: id(2), projectId: "p" })
    await vi.waitFor(() => expect(ids()).toEqual([id(1)]))
    // After a reconnection: row 1 is no more, row 4 is new; until `synced` nothing changes.
    stream.push({ type: "reset" })
    stream.push({ type: "changed", closed: closed(4) })
    expect(ids()).toEqual([id(1)])
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(ids()).toEqual([id(4)]))
  })

  it("reads a project's rows afresh, replacing the ones it held for it", async () => {
    const { history, stream, ids, listed } = followed((projectId) =>
      projectId === "p" ? [closed(5, { availability: { state: "gone", reason: "folder" } })] : [],
    )
    stream.push({ type: "reset" })
    stream.push({ type: "changed", closed: closed(1) })
    stream.push({ type: "changed", closed: closed(2, { projectId: "q" }) })
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(ids()).toEqual([id(2), id(1)]))
    const rows = await history.list("p")
    expect(listed).toEqual(["p"])
    expect(rows.map((row) => row.id)).toEqual([id(5)])
    expect(ids()).toEqual([id(5), id(2)])
  })
})

describe("a project's rows read while the stream speaks", () => {
  it("keeps what the stream said meanwhile over the older answer", async () => {
    let answer: (rows: ClosedTerminal[]) => void = () => {}
    const stream = channel<HistoryWatchItem>()
    const { history, follow } = createRunnerHistory({
      list: () => new Promise((resolve) => (answer = resolve)),
      watch: () => stream.iterator,
    })
    follow()
    const ids = () => history.state.getSnapshot().rows.map((row) => row.id)
    stream.push({ type: "reset" })
    stream.push({ type: "changed", closed: closed(1) })
    stream.push({ type: "changed", closed: closed(2) })
    stream.push({ type: "synced" })
    await vi.waitFor(() => expect(ids()).toEqual([id(2), id(1)]))
    const listed = history.list("p")
    // While the call is out: row 2 is restored, row 1 changes, row 3 closes.
    stream.push({ type: "removed", id: id(2), projectId: "p" })
    stream.push({ type: "changed", closed: closed(1, { availability: { state: "restoring" } }) })
    stream.push({ type: "changed", closed: closed(3) })
    await vi.waitFor(() => expect(ids()).toEqual([id(3), id(1)]))
    // The answer was read before any of that.
    answer([closed(2), closed(1)])
    expect((await listed).map((row) => row.id)).toEqual([id(3), id(1)])
    expect(ids()).toEqual([id(3), id(1)])
    expect(history.state.getSnapshot().rows[1]?.availability).toEqual({ state: "restoring" })
  })
})

describe("restoring a closed terminal", () => {
  it("asks the runner to create it from the row alone, naming no directory or title", async () => {
    const app = scripted({ shown: [] })
    const target = { projectId: "p", workspaceSessionId: id(8) }
    const terminal = app.backend.newTerminal({ target, directory: "/shop/sub", closed: id(40) })
    app.commit({ type: "terminal/add", target, terminal })
    await vi.waitFor(() => expect(app.of("create")).toHaveLength(1))
    expect(app.of("create")).toEqual([
      { id: terminal.id, sessionId: id(8), closed: id(40), cols: 80, rows: 24 },
    ])
    app.stop()
  })

  it("leaves an ordinary terminal's create as it was", async () => {
    const app = scripted({ shown: [] })
    const target = { projectId: "p", workspaceSessionId: id(8) }
    const terminal = app.backend.newTerminal({ target, directory: "/tmp" })
    app.commit({ type: "terminal/add", target, terminal })
    await vi.waitFor(() => expect(app.of("create")).toHaveLength(1))
    expect(app.of("create")).toEqual([expect.not.objectContaining({ closed: expect.anything() })])
    app.stop()
  })
})
