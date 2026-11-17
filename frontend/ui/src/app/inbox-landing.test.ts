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
        agentAvatars: false,
        onboardingTour: false,
        sound: true,
        soundVolume: 0.6,
        soundChoice: "theme",
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

// Whether the landed row `id` landed quietly.
const quietly = (inbox: ReturnType<typeof setup>["inbox"], id: string): boolean =>
  inbox.landedQuietly(inbox.state.getSnapshot().items.find((row) => row.id === id)!)

describe("the landing rule", () => {
  context("a row of the terminal being viewed", () => {
    it("lands at once, quietly, beside one of another terminal that lands as any row does", () => {
      const { set, inbox, ids, stop } = setup()
      set([ask("a", "01"), ask("b", "02")])
      expect(ids()).toEqual(["a", "b"])
      expect(quietly(inbox, "a")).toBe(true)
      expect(quietly(inbox, "b")).toBe(false)
      stop()
    })

    it("stays quiet when the person looks away", () => {
      const { set, select, focus, inbox, ids, stop } = setup()
      set([ask("a", "01")])
      select("02")
      focus(false)
      expect(ids()).toEqual(["a"])
      expect(quietly(inbox, "a")).toBe(true)
      stop()
    })

    it("lands as any row does while the page hasn't their focus", () => {
      const { set, focus, inbox, stop } = setup()
      focus(false)
      set([ask("a", "01")])
      expect(quietly(inbox, "a")).toBe(false)
      stop()
    })

    it("stays as it landed, and rung, once the person selects its terminal", () => {
      const { set, select, inbox, ids, stop } = setup()
      select("02")
      set([ask("a", "01")])
      select("01")
      expect(ids()).toEqual(["a"])
      expect(quietly(inbox, "a")).toBe(false)
      stop()
    })

    it("lands resolved as it is, even where its terminal is viewed", () => {
      const { set, ids, inbox, stop } = setup()
      set([{ ...ask("a", "01"), settled: { how: "dismissed", at: 2 } }])
      expect(ids()).toEqual(["a"])
      expect(inbox.state.getSnapshot().items[0]?.settled).toMatchObject({ how: "dismissed" })
      stop()
    })

    it("lands a newer row under the same id as another: quietly only if still viewed", () => {
      const { set, select, inbox, ids, stop } = setup()
      set([ask("a", "01")])
      set([{ ...ask("a", "01"), at: 2 }])
      expect(ids()).toEqual(["a"])
      expect(quietly(inbox, "a")).toBe(true)
      select("02")
      set([{ ...ask("a", "01"), at: 3 }])
      expect(quietly(inbox, "a")).toBe(false)
      stop()
    })
  })

  context("an update of the terminal being viewed", () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    it("lands at once, quietly, and is read once, after the dwell", () => {
      const { set, select, inbox, ids, answers, stop } = setup()
      set([done("d", "01")])
      expect(ids()).toEqual(["d"])
      expect(quietly(inbox, "d")).toBe(true)
      // Not synchronously, and not before the person has looked a moment.
      expect(answers).toEqual([])
      vi.advanceTimersByTime(readDwellMs - 1)
      expect(answers).toEqual([])
      vi.advanceTimersByTime(1)
      expect(answers).toEqual([["d", { kind: "update", action: "read" }]])
      // The read hasn't gone through yet; the row still shows as the person looks away.
      select("02")
      expect(ids()).toEqual(["d"])
      vi.advanceTimersByTime(readDwellMs * 3)
      expect(answers).toHaveLength(1)
      stop()
    })

    it("shows resolved once its read went through, as history", () => {
      const { set, ids, inbox, stop } = setup()
      set([done("d", "01")])
      vi.advanceTimersByTime(readDwellMs)
      set([{ ...done("d", "01"), settled: { how: "read", at: Date.now() } }])
      expect(ids()).toEqual(["d"])
      expect(inbox.state.getSnapshot().items[0]?.settled).toMatchObject({ how: "read" })
      stop()
    })

    it("is not read by a glance", () => {
      const { set, select, answers, stop } = setup()
      set([done("d", "01")])
      vi.advanceTimersByTime(readDwellMs - 1)
      select("02")
      vi.advanceTimersByTime(readDwellMs * 3)
      expect(answers).toEqual([])
      stop()
    })

    it("is read once the person selects its terminal for the dwell, after it landed elsewhere", () => {
      const { set, select, inbox, answers, stop } = setup()
      set([done("d", "02")])
      expect(quietly(inbox, "d")).toBe(false)
      select("02")
      expect(answers).toEqual([])
      vi.advanceTimersByTime(readDwellMs)
      expect(answers).toEqual([["d", { kind: "update", action: "read" }]])
      stop()
    })

    it("isn't read by looking once the person opened it by its id", () => {
      const { set, reveal, ids, answers, stop } = setup()
      set([done("d", "01")])
      vi.advanceTimersByTime(readDwellMs / 2)
      reveal("d")
      vi.advanceTimersByTime(readDwellMs * 3)
      expect(answers).toEqual([])
      expect(ids()).toEqual(["d"])
      stop()
    })

    it("isn't read again while the person looks once its read failed", () => {
      const { set, patch, ids, answers, stop } = setup()
      set([done("d", "01")])
      vi.advanceTimersByTime(readDwellMs)
      patch({ failed: { d: "Couldn't mark it read." } })
      expect(ids()).toEqual(["d"])
      vi.advanceTimersByTime(readDwellMs * 5)
      expect(answers).toHaveLength(1)
      stop()
    })

    it("isn't read again when it still stands after its read settled", () => {
      const { set, patch, ids, answers, stop } = setup()
      set([done("d", "01")])
      vi.advanceTimersByTime(readDwellMs)
      patch({ answering: { d: true } })
      patch({ answering: {} })
      vi.advanceTimersByTime(readDwellMs * 5)
      expect(ids()).toEqual(["d"])
      expect(answers).toHaveLength(1)
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

    it("skips the one of the terminal being viewed, and rings the one that arrived elsewhere", () => {
      const { set, rung, unfollow, stop } = follow()
      const now = Date.now()
      set([
        { ...ask("a", "01"), at: now },
        { ...ask("b", "02"), at: now },
      ])
      vi.advanceTimersByTime(500)
      expect(rung).toEqual(["b"])
      unfollow()
      stop()
    })

    it("doesn't ring the viewed one when the person looks away within the grace", () => {
      const { set, select, rung, unfollow, stop } = follow()
      set([{ ...ask("a", "01"), at: Date.now() }])
      vi.advanceTimersByTime(50)
      select("02")
      vi.advanceTimersByTime(500)
      expect(rung).toEqual([])
      unfollow()
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

  context("on a phone, while the Inbox list covers the screen", () => {
    it("lands it as any row: no terminal counts as viewed", () => {
      const { set, showList, inbox, stop } = setup(false)
      showList()
      set([ask("a", "01")])
      expect(quietly(inbox, "a")).toBe(false)
      stop()
    })

    it("follows the window crossing the breakpoint", () => {
      const { set, showList, resize, inbox, stop } = setup(true)
      showList()
      resize(false)
      set([ask("a", "01")])
      expect(quietly(inbox, "a")).toBe(false)
      stop()
    })

    it("lands it quietly on a wide window, where the terminal stays beside the list", () => {
      const { set, showList, inbox, stop } = setup(true)
      showList()
      set([ask("a", "01")])
      expect(quietly(inbox, "a")).toBe(true)
      stop()
    })
  })
})

describe("the landing's start and stop", () => {
  it("follows nothing once stopped", () => {
    const { set, ids, stop } = setup()
    set([ask("a", "01"), ask("b", "02")])
    expect(ids()).toEqual(["a", "b"])
    stop()
    set([ask("a", "01"), ask("b", "02"), ask("c", "02")])
    expect(ids()).toEqual(["a", "b"])
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
    read: false,
    ripe: false,
  }

  it("lands a new row of the viewed terminal quietly, and waits on nothing for it", () => {
    expect(decideRow(facts)).toEqual({ act: "none", quiet: true })
  })

  it("lands a row of a terminal not viewed as any row", () => {
    expect(decideRow({ ...facts, here: false })).toEqual({ act: "none", quiet: false })
  })

  it("doesn't hush a row that landed already", () => {
    expect(decideRow({ ...facts, landed: true }).quiet).toBe(false)
  })

  it("waits out the dwell on an update, then reads it, landed or not", () => {
    expect(decideRow({ ...facts, kind: "update" }).act).toBe("dwell")
    expect(decideRow({ ...facts, kind: "update", ripe: true }).act).toBe("read")
    expect(decideRow({ ...facts, kind: "update", landed: true, ripe: true }).act).toBe("read")
  })

  it("reads no update that is kept, read already, or not viewed", () => {
    const update = { ...facts, kind: "update" as const, ripe: true }
    expect(decideRow({ ...update, kept: true }).act).toBe("none")
    expect(decideRow({ ...update, read: true }).act).toBe("none")
    expect(decideRow({ ...update, here: false }).act).toBe("none")
  })
})
