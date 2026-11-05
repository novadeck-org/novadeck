import type { BackendAction } from "@novadeck/core/port"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { createWorkspaceStore } from "@novadeck/core/store"
import { afterEach, beforeEach, vi } from "vitest"

import { demoTerminalId } from "../samples"
import { context, describe, expect, it } from "../test"
import { reviewRestMs } from "./ambient"
import { visitorDemo } from "./index"

const session = { projectId: "storefront", workspaceSessionId: "initial" }
const claude = demoTerminalId(session, 1)
const codex = demoTerminalId(session, 4)
const readingMs = 1000

// The visitor demo against a workspace store, as the app runs it, with every action it
// dispatched kept.
const open = () => {
  const backend = visitorDemo({ readingMs, turnMs: 1000, nudgeMs: 2000 })
  const store = createWorkspaceStore(
    workspaceFromSeed(backend.seed, { view: "focus", windowedView: "grid", now: 0 }),
    backend.commit,
  )
  backend.commit(store.getSnapshot(), [])
  const dispatched: BackendAction[] = []
  const start = () =>
    backend.start!({
      dispatch: (actions) => {
        dispatched.push(...actions)
        store.transact(actions as never)
      },
      open: () => {},
    })
  const bind = () => backend.inbox!.bind!({ workspace: store })
  // The statuses reported for a terminal, oldest first.
  const statuses = (terminalId: string) =>
    dispatched.flatMap((action) =>
      action.type === "terminal/status" && action.terminalId === terminalId ? [action.status] : [],
    )
  const asked = (terminalId: string, kind: string) =>
    statuses(terminalId).filter(
      (status) => status.state === "running" && status.agent?.attention?.kind === kind,
    )
  const rows = () =>
    backend
      .inbox!.state.getSnapshot()
      .items.filter((row) => row.kind === "request" && row.source.terminalId === claude)
  return { backend, start, bind, statuses, asked, rows }
}

describe("the visitor demo", () => {
  it("offers exactly the fields the visitor page needs", () => {
    expect(Object.keys(visitorDemo()).toSorted()).toEqual([
      "commit",
      "companions",
      "demo",
      "inbox",
      "mountTerminal",
      "newTerminal",
      "seed",
      "setFont",
      "source",
      "start",
      "telemetry",
      "visitor",
    ])
  })

  context("when it is started, stopped and started again, as StrictMode does", () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it("asks for the plan once, its Inbox shows it, and Codex's review beats once", async () => {
      const { start, bind, asked, statuses, rows } = open()
      const stopFirst = start()
      const unbindFirst = bind()
      stopFirst()
      unbindFirst()
      const stop = start()
      const unbind = bind()
      await vi.advanceTimersByTimeAsync(readingMs)
      expect(asked(claude, "plan")).toHaveLength(1)
      expect(rows()).toEqual([
        expect.objectContaining({ request: expect.objectContaining({ kind: "plan" }) }),
      ])
      await vi.advanceTimersByTimeAsync(reviewRestMs - readingMs)
      const reviews = statuses(codex).filter(
        (status) => status.state === "running" && status.agent?.subagents !== undefined,
      )
      expect(reviews).toHaveLength(1)
      unbind()
      stop()
    })

    it("shows the plan in an Inbox that stayed bound across the restart", async () => {
      const { start, bind, asked, rows } = open()
      const unbind = bind()
      start()()
      const stop = start()
      await vi.advanceTimersByTimeAsync(readingMs)
      expect(asked(claude, "plan")).toHaveLength(1)
      expect(rows()).toEqual([
        expect.objectContaining({ request: expect.objectContaining({ kind: "plan" }) }),
      ])
      unbind()
      stop()
    })
  })
})
