import {
  emptyInbox,
  type Inbox,
  type InboxFinish,
  type InboxItem,
  type InboxTurn,
  type InboxState,
} from "@novadeck/core/inbox"
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
  error: null,
  files: [],
})

// A workspace whose terminal 01 is selected and 02 runs a resting agent, and an Inbox whose
// stored rows the test sets and whose reads drop them as the adapter does.
let wide = true

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
      sound: true,
      soundVolume: 0.6,
      soundChoice: "theme",
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
  const inboxState = createStore<InboxState>(emptyInbox)
  const letters = {
    ...inboxState,
    set: (items: readonly InboxItem[]) =>
      void inboxState.update((current) => ({ ...current, items })),
  }
  const inbox: Pick<Inbox, "turns" | "readFinishes" | "state"> = {
    state: inboxState,
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
  const watch = () =>
    watchUnreadTurns(inbox, workspace, ui, {
      notify: (notice, itemId) => {
        notices.push(notice)
        noticeItems.push(itemId)
      },
      clear: (terminalId) => cleared.push(terminalId),
      desktop: () => wide,
    })
  return {
    workspace,
    ui,
    turns,
    letters,
    readCalls,
    notices,
    noticeItems,
    cleared,
    watch,
    status,
    select,
    focus: (pageFocused: boolean) => ui.update((state) => ({ ...state, pageFocused })),
    unread: () => ui.getSnapshot().unread,
  }
}

const done = { "project/initial": { "02": "unread" } }

// A done report of terminal 02, as the Inbox lists it.
const letter = (id: string, at: number, seen = false): InboxItem => ({
  id,
  source: {
    projectId: "project",
    workspaceSessionId: "initial",
    terminalId: "02",
    handle: "fox",
    agent: "claude",
    title: "Checkout",
    projectName: "Project",
  },
  at: base + at,
  stopped: false,
  seen,
  kind: "update",
  update: { type: "done", subject: "Totals round per line", body: "Tests pass." },
})
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
      const stop = watchUnreadTurns({ state: createStore(emptyInbox) }, app.workspace, app.ui)
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

    it("reads nothing on a phone while the Inbox list covers the screen", () => {
      wide = false
      try {
        const app = setup({ rows: [row("a", 10)] })
        app.ui.update((current) => ({
          ...current,
          location: { ...current.location, route: { ...current.location.route, panel: "inbox" } },
          shell: { ...current.shell, sidebar: true },
        }))
        app.select("02")
        const stop = app.watch()
        expect(app.readCalls).toEqual([])
        stop()
      } finally {
        wide = true
      }
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
    it("are none for the reports and rows stored when it starts, nor for any after the backend lost them", () => {
      const app = setup({ rows: [row("a", 10, "failed")], pageFocused: false, notifyNeeds: false })
      app.letters.set([letter("l1", 10)])
      const stop = app.watch()
      expect(app.notices).toEqual([])
      app.turns.set(undefined)
      app.letters.set([letter("l1", 10), letter("l2", 20)])
      app.turns.set([row("a", 10, "failed"), row("b", 20, "failed")])
      expect(app.notices).toEqual([])
      stop()
    })

    it("fire for a new done report, with its subject, while the page isn't focused", () => {
      const app = setup({ rows: [], pageFocused: false })
      const stop = app.watch()
      app.letters.set([letter("l1", 10)])
      expect(app.notices).toEqual([
        { id: "02", title: "@fox is done: Checkout", body: "Totals round per line" },
      ])
      expect(app.noticeItems).toEqual(["l1"])
      stop()
    })

    it("are none for a bare completed turn, which is no finish", () => {
      const app = setup({ rows: [], pageFocused: false })
      const stop = app.watch()
      app.turns.set([row("a", 10)])
      expect(app.notices).toEqual([])
      expect(app.unread()).toEqual(done)
      stop()
    })

    it("are none while the page has the person's focus, or when they turned them off", () => {
      const focused = setup({ rows: [] })
      const stopFocused = focused.watch()
      focused.letters.set([letter("l1", 10)])
      expect(focused.notices).toEqual([])
      stopFocused()
      const off = setup({ rows: [], pageFocused: false, notifyFinished: false })
      const stopOff = off.watch()
      off.letters.set([letter("l1", 10)])
      expect(off.notices).toEqual([])
      stopOff()
    })

    it("are none for a report from well before this started", () => {
      const app = setup({ rows: [], pageFocused: false })
      const stop = app.watch()
      app.letters.set([letter("old", -60_000)])
      expect(app.notices).toEqual([])
      stop()
    })

    it("are none for a report that comes back after a failed read", () => {
      const app = setup({ rows: [], pageFocused: false })
      const stop = app.watch()
      app.letters.set([letter("l1", 10)])
      expect(app.notices).toHaveLength(1)
      app.turns.set(undefined)
      app.turns.set([])
      app.letters.set([letter("l1", 10)])
      expect(app.notices).toHaveLength(1)
      stop()
    })

    it("are one for a terminal, its newest report's", () => {
      const app = setup({ rows: [], pageFocused: false })
      const stop = app.watch()
      app.letters.set([letter("a", 10), letter("b", 20)])
      expect(app.notices).toHaveLength(1)
      expect(app.noticeItems).toEqual(["b"])
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
      expect(quiet.noticeItems).toEqual(["a"])
      stopQuiet()
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
      app.letters.set([letter("l1", 10)])
      expect(app.notices).toEqual([])
      stop()
    })

    it("close once the terminal has no unseen report: the person views it", () => {
      const app = setup({ rows: [], pageFocused: false })
      const stop = app.watch()
      app.letters.set([letter("l1", 10)])
      expect(app.cleared).toEqual([])
      app.select("02")
      app.focus(true)
      expect(app.cleared).toEqual(["02"])
      stop()
    })

    it("close once the report is seen elsewhere, and not before the last of two is", () => {
      const app = setup({ rows: [], pageFocused: false })
      const stop = app.watch()
      app.letters.set([letter("a", 10), letter("b", 20)])
      app.letters.set([letter("a", 10, true), letter("b", 20)])
      expect(app.cleared).toEqual([])
      app.letters.set([letter("a", 10, true), letter("b", 20, true)])
      expect(app.cleared).toEqual(["02"])
      stop()
    })

    it("close a failed row's once it is read", () => {
      const app = setup({ rows: [], pageFocused: false, notifyNeeds: false })
      const stop = app.watch()
      app.turns.set([row("a", 10, "failed")])
      expect(app.cleared).toEqual([])
      app.turns.set([])
      expect(app.cleared).toEqual(["02"])
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
