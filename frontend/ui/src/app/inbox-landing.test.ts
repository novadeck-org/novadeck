import {
  emptyInbox,
  type Inbox,
  type InboxAnswer,
  type InboxRow,
  type InboxState,
} from "@novadeck/core/inbox"
import { createStore, createWorkspaceStore } from "@novadeck/core/store"
import { appearance, workspaceFixture } from "@novadeck/core/testing"
import { afterEach, beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { decideRow, landInbox, readDwellMs, type RowFacts } from "./inbox-landing"
import { followNeeds } from "./inbox-pings"
import { createUiStore, initialUi } from "./ui-store"

const target = { projectId: "project", workspaceSessionId: "initial" }

const source = (terminalId: string): InboxRow["source"] => ({
  ...target,
  terminalId,
  handle: "moth",
  agent: "claude",
  title: "Checkout",
  projectName: "Project",
})

const ask = (id: string, terminalId: string): InboxRow => ({
  id,
  source: source(terminalId),
  at: 1,
  stopped: true,
  seen: false,
  kind: "ask",
  ask: { subject: "Which?", body: "", details: null, hardToUndo: null, shape: { type: "text" } },
})

const done = (id: string, terminalId: string): InboxRow => ({
  id,
  source: source(terminalId),
  at: 1,
  stopped: false,
  seen: false,
  kind: "update",
  update: { type: "done", subject: "Shipped", body: "All green." },
})

// A workspace whose terminal 01 is selected, and a raw Inbox the test fills and answers.
const setup = (initiallyWide = true) => {
  let wide = initiallyWide
  const widthListeners = new Set<() => void>()
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
        sound: true,
        soundVolume: 0.6,
        soundChoice: "theme",
      },
    }),
  )
  ui.update((state) => ({ ...state, pageFocused: true }))
  const state = createStore<InboxState>(emptyInbox)
  const answers: [string, InboxAnswer][] = []
  const cleared: string[][] = []
  const raw: Inbox = {
    state,
    clear: (ids) => void cleared.push([...ids]),
    answer: (id, answer) => void answers.push([id, answer]),
    see: () => {},
    readAll: () => {},
  }
  const { inbox, start, reveal } = landInbox(raw, workspace, ui, {
    is: () => wide,
    subscribe: (notify) => {
      widthListeners.add(notify)
      return () => void widthListeners.delete(notify)
    },
  })
  const stop = start()
  return {
    inbox,
    stop,
    restart: start,
    reveal,
    answers,
    cleared,
    set: (items: InboxRow[]) => void state.update((current) => ({ ...current, items })),
    patch: (patch: Partial<InboxState>) =>
      void state.update((current) => ({ ...current, ...patch })),
    resize: (next: boolean) => {
      wide = next
      widthListeners.forEach((notify) => notify())
    },
    showList: () =>
      void ui.update((current) => ({
        ...current,
        location: { ...current.location, route: { ...current.location.route, panel: "inbox" } },
        shell: { ...current.shell, sidebar: true },
      })),
    select: (terminalId: string) =>
      workspace.dispatch({ type: "terminal/select", target, terminalId }),
    focus: (pageFocused: boolean) => void ui.update((current) => ({ ...current, pageFocused })),
    ids: () => inbox.state.getSnapshot().items.map((row) => row.id),
  }
}

describe("the landing rule", () => {
  context("a row opened by its id", () => {
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

    it("does nothing for a row that is not there", () => {
      const { set, reveal, ids, stop } = setup()
      set([ask("a", "01")])
      reveal("gone")
      expect(ids()).toEqual([])
      stop()
    })
  })

  context("a row of the terminal being viewed", () => {
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

    it("never lands once it settled unseen, is cleared once, and a landed one stays settled", () => {
      const { set, select, ids, cleared, stop } = setup()
      const settled = { how: "replied" as const, at: 2 }
      set([ask("a", "01"), ask("b", "02")])
      set([
        { ...ask("a", "01"), settled },
        { ...ask("b", "02"), settled },
      ])
      expect(ids()).toEqual(["b"])
      expect(cleared).toEqual([["a"]])
      select("02")
      expect(ids()).toEqual(["b"])
      expect(cleared).toEqual([["a"]])
      stop()
    })

    it("shows a settled row at once, even where its terminal is viewed", () => {
      const { set, ids, cleared, stop } = setup()
      set([{ ...ask("a", "01"), settled: { how: "dismissed", at: 2 } }])
      expect(ids()).toEqual(["a"])
      expect(cleared).toEqual([])
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
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    it("is read once, after the dwell, and never lands", () => {
      const { set, select, ids, answers, stop } = setup()
      set([done("d", "01")])
      expect(ids()).toEqual([])
      // Not synchronously, and not before the person has looked a moment.
      expect(answers).toEqual([])
      vi.advanceTimersByTime(readDwellMs - 1)
      expect(answers).toEqual([])
      vi.advanceTimersByTime(1)
      expect(answers).toEqual([["d", { kind: "update", action: "read" }]])
      // The read hasn't gone through yet; the person looks away.
      select("02")
      expect(ids()).toEqual([])
      vi.advanceTimersByTime(readDwellMs * 3)
      expect(answers).toHaveLength(1)
      stop()
    })

    it("is not read by a glance: looking away within the dwell lands it", () => {
      const { set, select, ids, answers, stop } = setup()
      set([done("d", "01")])
      vi.advanceTimersByTime(readDwellMs - 1)
      select("02")
      vi.advanceTimersByTime(readDwellMs * 3)
      expect(answers).toEqual([])
      expect(ids()).toEqual(["d"])
      stop()
    })

    it("lands as any row does if it arrived while they looked elsewhere", () => {
      const { set, ids, answers, stop } = setup()
      set([done("d", "02")])
      expect(ids()).toEqual(["d"])
      expect(answers).toEqual([])
      stop()
    })

    it("is read once the person selects its terminal for the dwell, after it landed", () => {
      const { set, select, ids, answers, stop } = setup()
      set([done("d", "02")])
      expect(ids()).toEqual(["d"])
      select("02")
      expect(answers).toEqual([])
      vi.advanceTimersByTime(readDwellMs)
      expect(ids()).toEqual([])
      expect(answers).toEqual([["d", { kind: "update", action: "read" }]])
      stop()
    })

    it("is landed, not read, by a row opened by its id during the dwell", () => {
      const { set, reveal, ids, answers, stop } = setup()
      set([done("d", "01")])
      vi.advanceTimersByTime(readDwellMs / 2)
      reveal("d")
      vi.advanceTimersByTime(readDwellMs * 3)
      expect(answers).toEqual([])
      expect(ids()).toEqual(["d"])
      stop()
    })

    it("lands when its read failed, instead of staying hidden", () => {
      const { set, patch, ids, answers, stop } = setup()
      set([done("d", "01")])
      vi.advanceTimersByTime(readDwellMs)
      expect(ids()).toEqual([])
      patch({ failed: { d: "Couldn't mark it read." } })
      expect(ids()).toEqual(["d"])
      // It isn't read again over and over while the person still looks.
      vi.advanceTimersByTime(readDwellMs * 5)
      expect(answers).toHaveLength(1)
      stop()
    })

    it("lands when it still stands after its read settled", () => {
      const { set, patch, ids, stop } = setup()
      set([done("d", "01")])
      vi.advanceTimersByTime(readDwellMs)
      patch({ answering: { d: true } })
      expect(ids()).toEqual([])
      patch({ answering: {} })
      expect(ids()).toEqual(["d"])
      stop()
    })
  })

  context("a row that arrived while its terminal was viewed", () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    it("lands quietly once viewed for the dwell: no toast or ping, though it stays on the bell", () => {
      const { set, select, inbox, ids, stop } = setup()
      set([ask("a", "01"), ask("b", "02")])
      vi.advanceTimersByTime(readDwellMs)
      select("02")
      expect(ids()).toEqual(["a", "b"])
      const [a, b] = inbox.state.getSnapshot().items
      expect(inbox.landedQuietly(a!)).toBe(true)
      expect(inbox.landedQuietly(b!)).toBe(false)
      stop()
    })

    it("lands as any other if the person looked away within the dwell", () => {
      const { set, select, inbox, ids, stop } = setup()
      set([ask("a", "01")])
      vi.advanceTimersByTime(readDwellMs - 1)
      select("02")
      expect(ids()).toEqual(["a"])
      expect(inbox.landedQuietly(inbox.state.getSnapshot().items[0]!)).toBe(false)
      vi.advanceTimersByTime(readDwellMs * 3)
      expect(inbox.landedQuietly(inbox.state.getSnapshot().items[0]!)).toBe(false)
      stop()
    })
  })

  context("what rings for the rows that land", () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    const follow = () => {
      const made = setup()
      const rung: string[] = []
      const unfollow = followNeeds(made.inbox, {
        graceMs: 100,
        ring: (row) => rung.push(row.id) > 0,
        leave: () => {},
      })
      return { ...made, rung, unfollow }
    }

    it("skips the one viewed for the dwell, and rings the one that arrived elsewhere", () => {
      const { set, select, rung, unfollow, stop } = follow()
      const now = Date.now()
      set([
        { ...ask("a", "01"), at: now },
        { ...ask("b", "02"), at: now },
      ])
      vi.advanceTimersByTime(readDwellMs)
      select("02")
      vi.advanceTimersByTime(500)
      expect(rung).toEqual(["b"])
      unfollow()
      stop()
    })

    it("rings the one the person left within the dwell", () => {
      const { set, select, rung, unfollow, stop } = follow()
      set([{ ...ask("a", "01"), at: Date.now() }])
      vi.advanceTimersByTime(readDwellMs / 2)
      select("02")
      vi.advanceTimersByTime(500)
      expect(rung).toEqual(["a"])
      unfollow()
      stop()
    })
  })

  context("a landed row", () => {
    it("stays landed when its row is re-keyed while its terminal is viewed", () => {
      const { set, select, ids, stop } = setup()
      set([ask("a", "02")])
      expect(ids()).toEqual(["a"])
      select("02")
      select("01")
      set([{ ...ask("a", "02"), at: 2 }])
      select("02")
      select("01")
      expect(ids()).toEqual(["a"])
      stop()
    })

    it("lands again and stays through a re-key even while viewed", () => {
      const { set, select, ids, stop } = setup()
      set([ask("a", "01")])
      select("02")
      expect(ids()).toEqual(["a"])
      select("01")
      set([{ ...ask("a", "01"), at: 2 }])
      expect(ids()).toEqual(["a"])
      stop()
    })
  })

  context("once stopped", () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    it("arms no timer and sends no read", () => {
      const { set, reveal, answers, stop } = setup()
      set([done("d", "01")])
      stop()
      reveal("d")
      set([done("e", "01")])
      vi.advanceTimersByTime(readDwellMs * 5)
      expect(answers).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  context("a row opened by its id while its read is in flight", () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    it("lands anyway, and goes when the read completes", () => {
      const { set, patch, reveal, ids, stop } = setup()
      set([done("d", "01")])
      vi.advanceTimersByTime(readDwellMs)
      patch({ answering: { d: true } })
      expect(ids()).toEqual([])
      reveal("d")
      expect(ids()).toEqual(["d"])
      set([])
      expect(ids()).toEqual([])
      stop()
    })
  })

  context("on a phone, while the Inbox list covers the screen", () => {
    it("holds nothing back: no terminal counts as viewed", () => {
      const { set, showList, ids, stop } = setup(false)
      set([ask("a", "01")])
      expect(ids()).toEqual([])
      showList()
      expect(ids()).toEqual(["a"])
      stop()
    })

    it("follows the window crossing the breakpoint", () => {
      const { set, showList, resize, ids, stop } = setup(true)
      showList()
      set([ask("a", "01")])
      expect(ids()).toEqual([])
      resize(false)
      expect(ids()).toEqual(["a"])
      stop()
    })

    it("still holds back on a wide window, where the terminal stays beside the list", () => {
      const { set, showList, ids, stop } = setup(true)
      showList()
      set([ask("a", "01")])
      expect(ids()).toEqual([])
      stop()
    })
  })
})

describe("the landing's start and stop", () => {
  it("follows nothing once stopped", () => {
    const { set, ids, stop } = setup()
    set([ask("a", "01"), ask("b", "02")])
    expect(ids()).toEqual(["b"])
    stop()
    set([ask("a", "01"), ask("b", "02"), ask("c", "02")])
    expect(ids()).toEqual(["b"])
  })

  it("follows again when started again, as StrictMode does", () => {
    const { set, ids, stop, restart } = setup()
    stop()
    const stopAgain = restart()
    set([ask("a", "02")])
    expect(ids()).toEqual(["a"])
    stopAgain()
  })
})

describe("deciding one row", () => {
  const facts: RowFacts = {
    kind: "ask",
    here: true,
    landed: false,
    kept: false,
    quiet: false,
    ripe: false,
  }

  it("holds an unlanded row of the viewed terminal while it waits out the dwell", () => {
    expect(decideRow(facts)).toEqual({ act: "dwell", hold: true })
  })

  it("keeps holding it once ripe, now to land quietly when they look away", () => {
    expect(decideRow({ ...facts, ripe: true })).toEqual({ act: "quiet", hold: true })
  })

  it("reads an update seen for the dwell, landed or not", () => {
    expect(decideRow({ ...facts, kind: "update", ripe: true }).act).toBe("read")
    expect(decideRow({ ...facts, kind: "update", landed: true, ripe: true }).act).toBe("read")
  })

  it("lands a row of a terminal not viewed", () => {
    expect(decideRow({ ...facts, here: false })).toEqual({ act: "none", hold: false })
  })

  it("does not hold a landed row, nor one kept by the person's asking", () => {
    expect(decideRow({ ...facts, landed: true }).hold).toBe(false)
    expect(decideRow({ ...facts, kept: true, landed: true }).act).toBe("none")
  })

  it("waits no more on one that already landed quietly", () => {
    expect(decideRow({ ...facts, quiet: true })).toEqual({ act: "none", hold: true })
  })
})
