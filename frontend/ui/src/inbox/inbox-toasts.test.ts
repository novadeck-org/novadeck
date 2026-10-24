import { emptyInbox, type InboxItem, type InboxState } from "@novadeck/core/inbox"
import type { Notice } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import { appearance } from "@novadeck/core/testing"
import { afterEach, beforeEach, vi } from "vitest"

import { noticeBoard, watchInboxPings } from "../app/inbox-pings"
import { createUiStore, initialUi, type UiState } from "../app/ui-store"
import { context, describe, expect, it } from "../test"
import { watchInboxToasts } from "./inbox-toasts"

const sourceOf = (terminalId: string): InboxItem["source"] => ({
  projectId: "p",
  workspaceSessionId: "s",
  terminalId,
  handle: "moth",
  agent: "claude",
  title: "Checkout",
  projectName: "Project",
})

const ask = (id: string, terminalId = "t1", at = Date.now()): InboxItem => ({
  id,
  source: sourceOf(terminalId),
  at,
  stopped: true,
  seen: false,
  kind: "ask",
  ask: {
    subject: "Which database?",
    body: "",
    details: null,
    hardToUndo: null,
    shape: { type: "text" },
  },
})

const update = (id: string): InboxItem => ({
  id,
  source: sourceOf("t1"),
  at: Date.now(),
  stopped: false,
  seen: false,
  kind: "update",
  update: { type: "told", subject: "Done", body: "" },
})

const setup = (items: InboxItem[] = []) => {
  const inbox = createStore<InboxState>({ ...emptyInbox, items })
  const ui = createUiStore(
    initialUi({
      location: {
        route: {
          projectId: "project",
          sessionId: "initial",
          view: "focus",
          terminal: "t9",
          panel: "terminals",
          dialog: null,
          section: "general",
        },
        dialogDepth: 0,
        navigationType: "POP",
      },
      preferences: {
        fontSize: 13,
        enabledViews: ["focus"],
        appearance,
        notifyNeeds: true,
        notifyFinished: true,
        ligatures: false,
        chatView: false,
      },
    }),
  )
  const shown: string[] = []
  const closed: string[] = []
  const board = {
    show: (item: InboxItem) => void shown.push(`${item.source.terminalId}:${item.id}`),
    close: (terminalId: string, itemId: string) => void closed.push(`${terminalId}:${itemId}`),
  }
  const stop = watchInboxToasts({ state: inbox }, ui, board)
  const set = (next: InboxItem[]) => inbox.update((state) => ({ ...state, items: next }))
  const change = (patch: (state: UiState) => UiState) => ui.update(patch)
  const route = (patch: Partial<UiState["location"]["route"]>) =>
    change((state) => ({
      ...state,
      location: {
        ...state.location,
        route: { ...state.location.route, ...patch },
      },
    }))
  return { inbox, ui, set, change, route, shown, closed, stop }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
})
afterEach(() => void vi.useRealTimers())

describe("toasts for what needs the person", () => {
  context("when a new item needs them while Novadeck has their focus", () => {
    it("shows one toast once the grace has passed", () => {
      const { set, shown, stop } = setup()
      set([ask("a")])
      vi.advanceTimersByTime(1999)
      expect(shown).toEqual([])
      vi.advanceTimersByTime(1)
      expect(shown).toEqual(["t1:a"])
      stop()
    })

    it("shows none for an item that is answered within the grace, or for an update", () => {
      const { set, shown, stop } = setup()
      set([ask("a"), update("u")])
      vi.advanceTimersByTime(1000)
      set([update("u")])
      vi.advanceTimersByTime(5000)
      expect(shown).toEqual([])
      stop()
    })

    it("takes the items already there as seen", () => {
      const { shown, stop } = setup([ask("a")])
      vi.advanceTimersByTime(5000)
      expect(shown).toEqual([])
      stop()
    })

    it("waits out its whole grace again when it leaves before ringing and comes back", () => {
      const { set, shown, stop } = setup()
      const item = ask("a")
      set([item])
      vi.advanceTimersByTime(1000)
      set([])
      vi.advanceTimersByTime(500)
      set([item])
      vi.advanceTimersByTime(1999)
      expect(shown).toEqual([])
      vi.advanceTimersByTime(1)
      expect(shown).toEqual(["t1:a"])
      stop()
    })
  })

  context("when a rule fails as the item rings", () => {
    it("shows none while the person doesn't want them", () => {
      const { set, change, shown, stop } = setup()
      change((state) => ({
        ...state,
        preferences: { ...state.preferences, notifyNeeds: false },
      }))
      set([ask("a")])
      vi.advanceTimersByTime(5000)
      expect(shown).toEqual([])
      stop()
    })

    it("shows none while the Inbox is open, and none later for that item", () => {
      const { set, route, shown, stop } = setup()
      route({ panel: "inbox" })
      set([ask("a")])
      vi.advanceTimersByTime(2000)
      route({ panel: "terminals" })
      vi.advanceTimersByTime(5000)
      expect(shown).toEqual([])
      stop()
    })

    it("counts the Inbox as closed when the sidebar is collapsed", () => {
      const { set, route, change, shown, stop } = setup()
      route({ panel: "inbox" })
      change((state) => ({
        ...state,
        shell: { ...state.shell, sidebarCollapsed: true },
      }))
      set([ask("a")])
      vi.advanceTimersByTime(2000)
      expect(shown).toEqual(["t1:a"])
      stop()
    })

    it("shows none for the terminal the person is typing in", () => {
      const { set, route, shown, stop } = setup()
      route({ terminal: "t1" })
      set([ask("a", "t1"), ask("b", "t2")])
      vi.advanceTimersByTime(2000)
      expect(shown).toEqual(["t2:b"])
      stop()
    })

    it("shows none while the page doesn't have their focus", () => {
      const { set, change, shown, stop } = setup()
      change((state) => ({ ...state, pageFocused: false }))
      set([ask("a")])
      vi.advanceTimersByTime(5000)
      expect(shown).toEqual([])
      stop()
    })
  })

  context("while Preferences or Search is open as the item rings", () => {
    it("holds the toast until the dialog closes", () => {
      const { set, route, shown, stop } = setup()
      route({ dialog: "preferences" })
      set([ask("a")])
      vi.advanceTimersByTime(5000)
      expect(shown).toEqual([])
      route({ dialog: null })
      expect(shown).toEqual(["t1:a"])
      stop()
    })

    it("holds it for Search too", () => {
      const { set, route, shown, stop } = setup()
      route({ dialog: "search" })
      set([ask("a")])
      vi.advanceTimersByTime(2000)
      route({ dialog: null })
      expect(shown).toEqual(["t1:a"])
      stop()
    })

    it("drops it if its item was answered meanwhile", () => {
      const { set, route, shown, stop } = setup()
      route({ dialog: "search" })
      set([ask("a")])
      vi.advanceTimersByTime(2000)
      set([])
      vi.advanceTimersByTime(5000)
      route({ dialog: null })
      expect(shown).toEqual([])
      stop()
    })

    it("drops it if a rule fails once the dialog closes", () => {
      const { set, route, shown, stop } = setup()
      route({ dialog: "search" })
      set([ask("a")])
      vi.advanceTimersByTime(2000)
      route({ dialog: null, terminal: "t1" })
      expect(shown).toEqual([])
      stop()
    })

    it("shows only the newest of a terminal's held items", () => {
      const { set, route, shown, stop } = setup()
      route({ dialog: "search" })
      const first = ask("a")
      set([first])
      vi.advanceTimersByTime(2000)
      set([first, ask("b")])
      vi.advanceTimersByTime(2000)
      route({ dialog: null })
      expect(shown).toEqual(["t1:b"])
      stop()
    })
  })

  context("when a terminal gets a newer item", () => {
    it("shows it for the same terminal, which the board puts in place of the older", () => {
      const { set, shown, stop } = setup()
      const first = ask("a")
      set([first])
      vi.advanceTimersByTime(2000)
      set([first, ask("b")])
      vi.advanceTimersByTime(2000)
      expect(shown).toEqual(["t1:a", "t1:b"])
      stop()
    })
  })

  context("when an item with a toast leaves the Inbox", () => {
    it("takes its toast back once it has stayed gone for the grace", () => {
      const { set, closed, stop } = setup()
      set([ask("a")])
      vi.advanceTimersByTime(2000)
      set([])
      vi.advanceTimersByTime(1999)
      expect(closed).toEqual([])
      vi.advanceTimersByTime(1)
      expect(closed).toEqual(["t1:a"])
      stop()
    })

    it("keeps it when the item drops out of a recompute and comes back", () => {
      const { set, closed, stop } = setup()
      const item = ask("a")
      set([item])
      vi.advanceTimersByTime(2000)
      set([])
      vi.advanceTimersByTime(500)
      set([item])
      vi.advanceTimersByTime(5000)
      expect(closed).toEqual([])
      stop()
    })
  })

  context("when it stops", () => {
    it("rings nothing more", () => {
      const { set, shown, stop } = setup()
      set([ask("a")])
      stop()
      vi.advanceTimersByTime(5000)
      expect(shown).toEqual([])
    })
  })
})

describe("toasts and desktop notifications together", () => {
  const both = (focused: boolean) => {
    const { inbox, ui, set, change, shown } = setup()
    change((state) => ({ ...state, pageFocused: focused }))
    const pings: Notice[] = []
    const board = noticeBoard({
      show: (notice) => void pings.push(notice),
      close: () => {},
      onClick: () => () => {},
    })
    const stop = watchInboxPings({ state: inbox }, ui, { board })
    return { set, change, shown, pings, stop }
  }

  it("rings the toast alone while the page has the person's focus", () => {
    const { set, shown, pings, stop } = both(true)
    set([ask("a")])
    vi.advanceTimersByTime(5000)
    expect(shown).toEqual(["t1:a"])
    expect(pings).toEqual([])
    stop()
  })

  it("rings the desktop notification alone while it hasn't", () => {
    const { set, shown, pings, stop } = both(false)
    set([ask("a")])
    vi.advanceTimersByTime(5000)
    expect(shown).toEqual([])
    expect(pings).toHaveLength(1)
    stop()
  })

  it("rings whichever the focus says at the moment the grace ends", () => {
    const { set, change, shown, pings, stop } = both(true)
    set([ask("a")])
    vi.advanceTimersByTime(1000)
    change((state) => ({ ...state, pageFocused: false }))
    vi.advanceTimersByTime(1000)
    expect(shown).toEqual([])
    expect(pings).toHaveLength(1)
    stop()
  })
})
