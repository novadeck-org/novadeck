import type { Inbox, InboxFinish, InboxTurn } from "@novadeck/core/inbox"
import { createStore, createWorkspaceStore } from "@novadeck/core/store"
import { appearance, workspaceFixture } from "@novadeck/core/testing"
import type { AgentStatus } from "@novadeck/core/types"

import { context, describe, expect, it } from "../test"
import { createUiStore, initialUi } from "./ui-store"
import { watchUnreadTurns, type FinishNotify } from "./unread-turns"

const target = { projectId: "project", workspaceSessionId: "initial" }
const base = Date.now()

const row = (
  id: string,
  at: number,
  outcome: InboxTurn["outcome"] = "completed",
  terminalId = "02",
): InboxTurn => ({
  id,
  projectId: "project",
  workspaceSessionId: "initial",
  terminalId,
  handle: "fox",
  agent: "claude",
  at: base + at,
  outcome,
  reply: "All green.",
  gist: null,
  error: null,
  files: [],
})

// A workspace whose terminal 01 is selected and 02 runs a resting agent, and an Inbox whose
// stored rows the test sets and whose reads drop them as the adapter does.
const setup = ({
  rows,
  notifyFinished = true,
  notifyNeeds = true,
  pageFocused: focused = true,
  reads = true,
}: {
  rows?: readonly InboxTurn[] | undefined
  notifyFinished?: boolean
  notifyNeeds?: boolean
  pageFocused?: boolean
  reads?: boolean
} = {}) => {
  const workspace = createWorkspaceStore(workspaceFixture())
  const initial = initialUi({
    location: {
      route: {
        projectId: "project",
        sessionId: "initial",
        view: "focus",
        terminal: "",
        panel: "terminals",
        dialog: null,
        section: "general",
      },
      dialogDepth: 0,
      navigationType: "POP",
    },
    preferences: {
      fontSize: 13,
      enabledViews: ["focus", "grid"],
      appearance,
      notifyNeeds,
      notifyFinished,
      ligatures: false,
      chatView: false,
    },
  })
  const ui = createUiStore({ ...initial, pageFocused: focused })
  const store = createStore<readonly InboxTurn[] | undefined>(rows)
  const turns = {
    ...store,
    set: (next: readonly InboxTurn[] | undefined) => void store.update(() => next),
  }
  const readCalls: InboxFinish[][] = []
  const inbox: Pick<Inbox, "turns" | "readFinishes"> = {
    turns,
    readFinishes: (finishes) => {
      readCalls.push([...finishes])
      if (!reads) return
      turns.set(
        (turns.getSnapshot() ?? []).filter(
          (turn) =>
            !finishes.some(
              (each) =>
                each.context === `${turn.projectId}/${turn.workspaceSessionId}` &&
                each.terminalId === turn.terminalId,
            ),
        ),
      )
    },
  }
  const status = (terminalId: string, agent: AgentStatus) =>
    workspace.dispatch({
      type: "terminal/status",
      target,
      terminalId,
      status: { state: "running", agent },
    })
  const select = (terminalId: string) =>
    workspace.dispatch({ type: "terminal/select", target, terminalId })
  workspace.dispatch({
    type: "terminal/update",
    target,
    terminalId: "02",
    name: "Checkout",
    handle: "fox",
  })
  select("01")
  status("02", { working: false })
  const notices: Parameters<FinishNotify>[0][] = []
  const noticeItems: string[] = []
  const cleared: string[] = []
  const gists: [string, number][] = []
  const watch = () =>
    watchUnreadTurns(inbox, workspace, ui, {
      notify: (notice, itemId) => {
        notices.push(notice)
        noticeItems.push(itemId)
      },
      clear: (terminalId) => cleared.push(terminalId),
      gist: (terminalId, at) => gists.push([terminalId, at]),
    })
  return {
    workspace,
    ui,
    turns,
    readCalls,
    notices,
    noticeItems,
    cleared,
    gists,
    watch,
    status,
    select,
    focus: (pageFocused: boolean) => ui.update((state) => ({ ...state, pageFocused })),
    unread: () => ui.getSnapshot().unread,
  }
}

const done = { "project/initial": { "02": "done" } }
const failed = { "project/initial": { "02": "failed" } }

describe("unread turns", () => {
  context("the marks", () => {
    it("mirror each terminal's newest row's outcome", () => {
      const app = setup({ rows: [row("a", 10, "failed"), row("b", 20)] })
      const stop = app.watch()
      expect(app.unread()).toEqual(done)
      app.turns.set([row("a", 10), row("b", 20, "failed")])
      expect(app.unread()).toEqual(failed)
      stop()
    })

    it("survive the agent's next turn, and go with the row", () => {
      const app = setup({ rows: [row("a", 10)] })
      const stop = app.watch()
      app.status("02", { working: true })
      expect(app.unread()).toEqual(done)
      app.turns.set([])
      expect(app.unread()).toEqual({})
      stop()
    })

    it("also say the rows hidden under a running lead", () => {
      const app = setup({ rows: [row("a", 10)] })
      app.workspace.dispatch({ type: "terminal/update", target, terminalId: "01", handle: "moth" })
      app.workspace.dispatch({ type: "terminal/update", target, terminalId: "02", ledBy: "moth" })
      app.status("01", { working: true })
      const stop = app.watch()
      expect(app.unread()).toEqual(done)
      stop()
    })

    it("leave out a worker's finished rows while its lead's agent runs, and show them once it stops", () => {
      const app = setup({ rows: [row("a", 10), row("f", 20, "failed")] })
      app.workspace.dispatch({ type: "terminal/update", target, terminalId: "01", handle: "moth" })
      app.workspace.dispatch({ type: "terminal/update", target, terminalId: "02", ledBy: "moth" })
      app.workspace.dispatch({
        type: "terminal/process",
        target,
        terminalId: "01",
        process: "claude",
      })
      app.status("01", { working: true })
      app.turns.set([row("a", 10)])
      const stop = app.watch()
      expect(app.unread()).toEqual({})
      app.workspace.dispatch({ type: "terminal/process", target, terminalId: "01", process: "zsh" })
      expect(app.unread()).toEqual(done)
      stop()
    })

    it("are none before the backend lists its rows, and again once it stops", () => {
      const app = setup()
      const stop = app.watch()
      expect(app.unread()).toEqual({})
      app.turns.set([row("a", 10)])
      expect(app.unread()).toEqual(done)
      app.turns.set(undefined)
      expect(app.unread()).toEqual({})
      stop()
    })

    it("do nothing for a backend that stores no rows", () => {
      const app = setup()
      const stop = watchUnreadTurns({}, app.workspace, app.ui)
      expect(app.unread()).toEqual({})
      stop()
    })
  })

  context("looking", () => {
    it("reads the rows of the terminal the person selects", () => {
      const app = setup({ rows: [row("a", 10), row("b", 20, "failed")] })
      const stop = app.watch()
      expect(app.readCalls).toEqual([])
      app.select("02")
      expect(app.readCalls).toEqual([[{ context: "project/initial", terminalId: "02" }]])
      expect(app.unread()).toEqual({})
      stop()
    })

    it("reads a row that lands while the person views its terminal", () => {
      const app = setup({ rows: [] })
      app.select("02")
      const stop = app.watch()
      app.turns.set([row("a", 10)])
      expect(app.readCalls).toHaveLength(1)
      expect(app.turns.getSnapshot()).toEqual([])
      stop()
    })

    it("reads the selected terminal's stored rows on a focused launch", () => {
      const app = setup({ rows: [row("a", 10), row("b", 12, "completed", "01")] })
      app.select("02")
      const stop = app.watch()
      expect(app.readCalls).toEqual([[{ context: "project/initial", terminalId: "02" }]])
      expect(app.turns.getSnapshot()).toEqual([row("b", 12, "completed", "01")])
      stop()
    })

    it("waits for the page's focus, then reads", () => {
      const app = setup({ rows: [row("a", 10)], pageFocused: false })
      app.select("02")
      const stop = app.watch()
      expect(app.readCalls).toEqual([])
      expect(app.unread()).toEqual(done)
      app.focus(true)
      expect(app.readCalls).toHaveLength(1)
      expect(app.unread()).toEqual({})
      stop()
    })

    it("asks once for a row while the backend still lists it", () => {
      const app = setup({ rows: [row("a", 10)], reads: false })
      app.select("02")
      const stop = app.watch()
      app.focus(false)
      app.focus(true)
      app.status("02", { working: true })
      expect(app.readCalls).toHaveLength(1)
      stop()
    })
  })

  context("the notices", () => {
    it("are none for the rows stored when it starts, nor for any after the backend lost them", () => {
      const app = setup({ rows: [row("a", 10)], pageFocused: false })
      const stop = app.watch()
      expect(app.notices).toEqual([])
      app.turns.set(undefined)
      app.turns.set([row("a", 10), row("b", 20)])
      expect(app.notices).toEqual([])
      stop()
    })

    it("show a new row's terminal, with the start of its reply, while the page isn't focused", () => {
      const app = setup({ rows: [], pageFocused: false })
      const stop = app.watch()
      app.turns.set([row("a", 10)])
      expect(app.notices).toEqual([
        { id: "02", title: "@fox is done: Checkout", body: "All green." },
      ])
      stop()
    })

    it("are none while the page has the person's focus, or when they turned them off", () => {
      const focused = setup({ rows: [] })
      const stopFocused = focused.watch()
      focused.turns.set([row("a", 10)])
      expect(focused.notices).toEqual([])
      stopFocused()
      const off = setup({ rows: [], pageFocused: false, notifyFinished: false })
      const stopOff = off.watch()
      off.turns.set([row("a", 10)])
      expect(off.notices).toEqual([])
      stopOff()
    })

    it("are none for a row that ended well before this started", () => {
      const app = setup({ rows: [], pageFocused: false })
      const stop = app.watch()
      app.turns.set([{ ...row("a", 10), at: base - 60_000 }])
      expect(app.notices).toEqual([])
      stop()
    })

    it("are none for a row that comes back after a failed read", () => {
      const app = setup({ rows: [], pageFocused: false })
      const stop = app.watch()
      app.turns.set([row("a", 10)])
      expect(app.notices).toHaveLength(1)
      app.turns.set([])
      app.turns.set([row("a", 10)])
      expect(app.notices).toHaveLength(1)
      stop()
    })

    it("are one for a terminal, its newest row's", () => {
      const app = setup({ rows: [], pageFocused: false })
      const stop = app.watch()
      app.turns.set([row("a", 10), row("b", 20)])
      expect(app.notices).toHaveLength(1)
      app.turns.set([row("a", 10), row("b", 20), row("c", 30)])
      expect(app.notices).toHaveLength(2)
      expect(app.notices.map((notice) => notice.id)).toEqual(["02", "02"])
      stop()
    })

    it("leave a failed row to the Inbox's trouble, unless the person turned that off", () => {
      const app = setup({ rows: [], pageFocused: false })
      const stop = app.watch()
      app.turns.set([row("a", 10, "failed")])
      expect(app.notices).toEqual([])
      stop()
      const quiet = setup({ rows: [], pageFocused: false, notifyNeeds: false })
      const stopQuiet = quiet.watch()
      quiet.turns.set([row("a", 10, "failed")])
      expect(quiet.notices).toEqual([
        { id: "02", title: "@fox stopped with an error: Checkout", body: "All green." },
      ])
      stopQuiet()
    })

    it("name the row they show, which a click opens", () => {
      const app = setup({ rows: [], pageFocused: false })
      const stop = app.watch()
      app.turns.set([row("a", 10), row("b", 20)])
      expect(app.noticeItems).toEqual(["b"])
      stop()
    })

    it("are none for a worker whose lead's agent runs", () => {
      const app = setup({ rows: [], pageFocused: false })
      app.workspace.dispatch({ type: "terminal/update", target, terminalId: "01", handle: "moth" })
      app.workspace.dispatch({ type: "terminal/update", target, terminalId: "02", ledBy: "moth" })
      app.workspace.dispatch({
        type: "terminal/process",
        target,
        terminalId: "01",
        process: "claude",
      })
      app.status("01", { working: true })
      const stop = app.watch()
      app.turns.set([row("a", 10)])
      expect(app.notices).toEqual([])
      stop()
    })

    it("close once the terminal has no unread row: the person views it", () => {
      const app = setup({ rows: [], pageFocused: false })
      const stop = app.watch()
      app.turns.set([row("a", 10)])
      expect(app.cleared).toEqual([])
      app.select("02")
      app.focus(true)
      expect(app.cleared).toEqual(["02"])
      stop()
    })

    it("close once the row is read elsewhere, and not before the last of two is", () => {
      const app = setup({ rows: [], pageFocused: false })
      const stop = app.watch()
      app.turns.set([row("a", 10), row("b", 20)])
      app.turns.set([row("b", 20)])
      expect(app.cleared).toEqual([])
      app.turns.set([])
      expect(app.cleared).toEqual(["02"])
      stop()
    })
  })

  context("the gists", () => {
    it("are asked once for a row without one, whose end is its agent's current", () => {
      const app = setup({ rows: [] })
      app.status("02", { working: false, lastTurn: { outcome: "completed", at: base + 10 } })
      const stop = app.watch()
      app.turns.set([row("a", 10)])
      app.status("02", {
        working: false,
        lastTurn: { outcome: "completed", at: base + 10, reply: "x" },
      })
      expect(app.gists).toEqual([["02", base + 10]])
      stop()
    })

    it("are not asked for an end the agent has moved past, a row with a gist, or a viewed terminal", () => {
      const app = setup({ rows: [] })
      app.status("02", { working: false, lastTurn: { outcome: "completed", at: base + 20 } })
      const stop = app.watch()
      app.turns.set([row("old", 10), { ...row("with", 20), gist: "Fixed it" }])
      expect(app.gists).toEqual([])
      app.select("02")
      app.turns.set([row("now", 20)])
      expect(app.gists).toEqual([])
      stop()
    })
  })

  it("stops following when stopped", () => {
    const app = setup({ rows: [], pageFocused: false })
    const stop = app.watch()
    stop()
    app.turns.set([row("a", 10)])
    expect(app.unread()).toEqual({})
    expect(app.notices).toEqual([])
  })
})
