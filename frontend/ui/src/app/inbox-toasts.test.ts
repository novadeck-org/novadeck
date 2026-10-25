import { emptyInbox, type InboxItem, type InboxState } from "@novadeck/core/inbox"
import type { Notice } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import { appearance } from "@novadeck/core/testing"
import { afterEach, beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { noticeBoard, watchInboxPings } from "./inbox-pings"
import { watchInboxToasts } from "./inbox-toasts"
import { createUiStore, initialUi, type UiState } from "./ui-store"

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

const draft = (id: string): InboxItem => ({
  id,
  source: sourceOf("t1"),
  at: Date.now(),
  stopped: false,
  seen: false,
  kind: "feedback",
  draft: { kind: "bug", text: "It broke." },
})

const setup = (items: InboxItem[] = [], pings = true) => {
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
  const stop = watchInboxToasts({ state: inbox }, ui, board, { pings, desktop: () => true })
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

    it("shows none for a feedback draft, which waits in the Inbox without calling", () => {
      const { set, shown, stop } = setup()
      set([draft("f")])
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
      route({ dialog: null, panel: "inbox" })
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

  context("while the person leaves the app with the dialog open", () => {
    it("drops the held toast, which the desktop notification takes", () => {
      const { set, route, change, shown, stop } = setup()
      route({ dialog: "search" })
      set([ask("a")])
      vi.advanceTimersByTime(2000)
      change((state) => ({ ...state, pageFocused: false }))
      route({ dialog: null })
      change((state) => ({ ...state, pageFocused: true }))
      expect(shown).toEqual([])
      stop()
    })
  })

  context(
    "while the person leaves the app with the dialog open and no ping can take the item",
    () => {
      it("keeps it held until they return and the dialog is closed", () => {
        const { set, route, change, shown, stop } = setup([], false)
        route({ dialog: "search" })
        set([ask("a")])
        vi.advanceTimersByTime(2000)
        change((state) => ({ ...state, pageFocused: false }))
        route({ dialog: null })
        expect(shown).toEqual([])
        change((state) => ({ ...state, pageFocused: true }))
        expect(shown).toEqual(["t1:a"])
        stop()
      })
    },
  )

  context("while another modal dialog is open as the item rings", () => {
    it("holds the toast for the close confirmation, the crash-loop question and the switcher", () => {
      const { set, change, shown, stop } = setup()
      const open = [
        (state: UiState): UiState => ({ ...state, closing: { context: "c", id: "t1" } }),
        (state: UiState): UiState => ({ ...state, crashLoop: 3 }),
        (state: UiState): UiState => ({
          ...state,
          recent: { ...state.recent, switcher: { mode: "click" } as never },
        }),
      ]
      const shut = (state: UiState): UiState => ({
        ...state,
        closing: null,
        crashLoop: 0,
        recent: { ...state.recent, switcher: null },
      })
      for (const [index, hold] of open.entries()) {
        change(hold)
        set([ask(`a${index}`)])
        vi.advanceTimersByTime(2000)
        expect(shown).toHaveLength(index)
        change(shut)
        expect(shown).toHaveLength(index + 1)
      }
      stop()
    })
  })

  context("when a held item leaves and returns", () => {
    it("shows its toast once, not again when its new grace ends", () => {
      const { set, route, shown, stop } = setup()
      const item = ask("a")
      route({ dialog: "search" })
      set([item])
      vi.advanceTimersByTime(2000)
      set([])
      vi.advanceTimersByTime(2000)
      set([item])
      vi.advanceTimersByTime(1000)
      route({ dialog: null })
      vi.advanceTimersByTime(5000)
      expect(shown).toEqual(["t1:a"])
      stop()
    })
  })

  context("when a modal dialog opens over standing toasts", () => {
    it("closes them all, leaving their items in the Inbox", () => {
      const { set, inbox, route, closed, stop } = setup()
      set([ask("a", "t1"), ask("b", "t2")])
      vi.advanceTimersByTime(2000)
      route({ dialog: "search" })
      expect(closed).toEqual(["t1:a", "t2:b"])
      expect(inbox.getSnapshot().items).toHaveLength(2)
      stop()
    })
  })

  context("when the switcher is held open by Ctrl+Tab", () => {
    it("leaves standing toasts up, and holds none that ring", () => {
      const { set, change, closed, shown, stop } = setup()
      const first = ask("a", "t1")
      set([first])
      vi.advanceTimersByTime(2000)
      change((state) => ({
        ...state,
        recent: { ...state.recent, switcher: { mode: "held" } as never },
      }))
      set([first, ask("b", "t2")])
      vi.advanceTimersByTime(2000)
      expect(closed).toEqual([])
      expect(shown).toEqual(["t1:a", "t2:b"])
      stop()
    })
  })

  context("when a dialog closes standing toasts", () => {
    const closing = (state: UiState): UiState => ({ ...state, closing: { context: "c", id: "t1" } })
    const crashing = (state: UiState): UiState => ({ ...state, crashLoop: 3 })
    it.each([
      ["the close confirmation", closing],
      ["the crash-loop question", crashing],
    ])("does so for %s, and they do not return as it closes", (_name, open) => {
      const { set, change, closed, shown, stop } = setup()
      set([ask("a", "t1")])
      vi.advanceTimersByTime(2000)
      change(open)
      expect(closed).toEqual(["t1:a"])
      change((state) => ({ ...state, closing: null, crashLoop: 0 }))
      vi.advanceTimersByTime(5000)
      expect(shown).toEqual(["t1:a"])
      stop()
    })

    it("still shows an item held meanwhile once it closes", () => {
      const { set, route, closed, shown, stop } = setup()
      const first = ask("a", "t1")
      set([first])
      vi.advanceTimersByTime(2000)
      route({ dialog: "search" })
      expect(closed).toEqual(["t1:a"])
      set([first, ask("b", "t2")])
      vi.advanceTimersByTime(2000)
      route({ dialog: null })
      expect(shown).toEqual(["t1:a", "t2:b"])
      stop()
    })
  })

  context("when the person gets to what a toast says", () => {
    it("closes every toast as the Inbox opens", () => {
      const { set, route, closed, stop } = setup()
      set([ask("a", "t1"), ask("b", "t2")])
      vi.advanceTimersByTime(2000)
      route({ panel: "inbox" })
      expect(closed).toEqual(["t1:a", "t2:b"])
      stop()
    })

    it("closes the one of a terminal as it is selected, and no other", () => {
      const { set, route, closed, stop } = setup()
      set([ask("a", "t1"), ask("b", "t2")])
      vi.advanceTimersByTime(2000)
      route({ terminal: "t2" })
      expect(closed).toEqual(["t2:b"])
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
    const stop = watchInboxPings({ state: inbox }, ui, { board, desktop: () => true })
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

describe("an item held behind a modal dialog", () => {
  const held = () => {
    const { inbox, ui, set, change, route, shown } = setup()
    const pings: Notice[] = []
    const board = noticeBoard({
      show: (notice) => void pings.push(notice),
      close: () => {},
      onClick: () => () => {},
    })
    const stop = watchInboxPings({ state: inbox }, ui, { board, desktop: () => true })
    route({ dialog: "search" })
    set([ask("a")])
    vi.advanceTimersByTime(2000)
    return { set, change, route, shown, pings, stop }
  }

  it("goes to the desktop notification when the person leaves the app first", () => {
    const { change, route, shown, pings, stop } = held()
    expect(pings).toEqual([])
    change((state) => ({ ...state, pageFocused: false }))
    expect(pings).toHaveLength(1)
    route({ dialog: null })
    change((state) => ({ ...state, pageFocused: true }))
    expect(shown).toEqual([])
    expect(pings).toHaveLength(1)
    stop()
  })

  it("goes to the toast when the dialog closes first, and never pings after", () => {
    const { change, route, shown, pings, stop } = held()
    route({ dialog: null })
    expect(shown).toEqual(["t1:a"])
    change((state) => ({ ...state, pageFocused: false }))
    expect(pings).toEqual([])
    stop()
  })

  it("is forgotten by the ping once its item leaves", () => {
    const { set, change, pings, stop } = held()
    set([])
    vi.advanceTimersByTime(2000)
    change((state) => ({ ...state, pageFocused: false }))
    expect(pings).toEqual([])
    stop()
  })
})

describe("an item that no toast waits for", () => {
  it("is not deferred to the ping either: it never pings behind a dialog", () => {
    const { inbox, ui, set, change, route } = setup()
    const pings: Notice[] = []
    const board = noticeBoard({
      show: (notice) => void pings.push(notice),
      close: () => {},
      onClick: () => () => {},
    })
    const stop = watchInboxPings({ state: inbox }, ui, { board, desktop: () => true })
    // The Inbox is what the person looks at, so no toast would wait for the item.
    route({ dialog: "preferences", panel: "inbox" })
    set([ask("a", "t1")])
    vi.advanceTimersByTime(2000)
    change((state) => ({ ...state, pageFocused: false }))
    expect(pings).toEqual([])
    stop()
  })
})
