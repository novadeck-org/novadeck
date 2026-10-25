import {
  emptyInbox,
  type Inbox,
  type InboxAnswer,
  type InboxItem,
  type InboxState,
} from "@novadeck/core/inbox"
import { createStore, createWorkspaceStore } from "@novadeck/core/store"
import { appearance, workspaceFixture } from "@novadeck/core/testing"

import { context, describe, expect, it } from "../test"
import { landInbox } from "./inbox-landing"
import { createUiStore, initialUi } from "./ui-store"

const target = { projectId: "project", workspaceSessionId: "initial" }

const source = (terminalId: string): InboxItem["source"] => ({
  ...target,
  terminalId,
  handle: "moth",
  agent: "claude",
  title: "Checkout",
  projectName: "Project",
})

const ask = (id: string, terminalId: string): InboxItem => ({
  id,
  source: source(terminalId),
  at: 1,
  stopped: true,
  seen: false,
  kind: "ask",
  ask: { subject: "Which?", body: "", details: null, hardToUndo: null, shape: { type: "text" } },
})

const done = (id: string, terminalId: string): InboxItem => ({
  id,
  source: source(terminalId),
  at: 1,
  stopped: false,
  seen: false,
  kind: "update",
  update: { type: "done", subject: "Shipped", body: "All green." },
})

// A workspace whose terminal 01 is selected, and a raw Inbox the test fills and answers.
const setup = () => {
  const workspace = createWorkspaceStore(workspaceFixture())
  workspace.dispatch({ type: "terminal/select", target, terminalId: "01" })
  const ui = createUiStore(
    initialUi({
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
        notifyNeeds: true,
        notifyFinished: true,
        ligatures: false,
        chatView: false,
      },
    }),
  )
  ui.update((state) => ({ ...state, pageFocused: true }))
  const state = createStore<InboxState>(emptyInbox)
  const answers: [string, InboxAnswer][] = []
  const raw: Inbox = {
    state,
    answer: (id, answer) => void answers.push([id, answer]),
    see: () => {},
    readAll: () => {},
  }
  const { inbox, stop, reveal } = landInbox(raw, workspace, ui)
  return {
    inbox,
    stop,
    reveal,
    answers,
    set: (items: InboxItem[]) => void state.update((current) => ({ ...current, items })),
    select: (terminalId: string) =>
      workspace.dispatch({ type: "terminal/select", target, terminalId }),
    focus: (pageFocused: boolean) => void ui.update((current) => ({ ...current, pageFocused })),
    ids: () => inbox.state.getSnapshot().items.map((item) => item.id),
  }
}

describe("the landing rule", () => {
  context("an item opened by its id", () => {
    it("lands even while its terminal is viewed, and stays after they look away", () => {
      const { set, select, reveal, ids, stop } = setup()
      set([ask("a", "01"), ask("b", "01")])
      expect(ids()).toEqual([])
      reveal("a")
      expect(ids()).toEqual(["a"])
      select("02")
      expect(ids()).toEqual(["a", "b"])
      stop()
    })

    it("does nothing for an item that is not there", () => {
      const { set, reveal, ids, stop } = setup()
      set([ask("a", "01")])
      reveal("gone")
      expect(ids()).toEqual([])
      stop()
    })
  })

  context("an item of the terminal being viewed", () => {
    it("doesn't land while the person looks, and lands when they select another terminal", () => {
      const { set, select, ids, stop } = setup()
      set([ask("a", "01"), ask("b", "02")])
      expect(ids()).toEqual(["b"])
      select("02")
      expect(ids()).toEqual(["a", "b"])
      stop()
    })

    it("lands when the page loses their focus", () => {
      const { set, focus, ids, stop } = setup()
      set([ask("a", "01")])
      expect(ids()).toEqual([])
      focus(false)
      expect(ids()).toEqual(["a"])
      stop()
    })

    it("never lands once it was answered while they looked", () => {
      const { set, select, ids, stop } = setup()
      set([ask("a", "01")])
      set([])
      select("02")
      expect(ids()).toEqual([])
      stop()
    })

    it("stays landed after the person selects its terminal", () => {
      const { set, select, ids, stop } = setup()
      select("02")
      set([ask("a", "01")])
      expect(ids()).toEqual(["a"])
      select("01")
      expect(ids()).toEqual(["a"])
      stop()
    })
  })

  context("an update of the terminal being viewed", () => {
    it("is read, once, and never lands", () => {
      const { set, select, ids, answers, stop } = setup()
      set([done("d", "01")])
      expect(ids()).toEqual([])
      expect(answers).toEqual([["d", { kind: "update", action: "read" }]])
      // The read hasn't gone through yet; the person looks away.
      select("02")
      expect(ids()).toEqual([])
      expect(answers).toHaveLength(1)
      stop()
    })

    it("lands as any item does if it arrived while they looked elsewhere", () => {
      const { set, ids, answers, stop } = setup()
      set([done("d", "02")])
      expect(ids()).toEqual(["d"])
      expect(answers).toEqual([])
      stop()
    })

    it("is read once the person selects its terminal, after it landed", () => {
      const { set, select, ids, answers, stop } = setup()
      set([done("d", "02")])
      expect(ids()).toEqual(["d"])
      select("02")
      expect(ids()).toEqual([])
      expect(answers).toEqual([["d", { kind: "update", action: "read" }]])
      stop()
    })
  })
})
