import {
  emptyInbox,
  type Inbox,
  type InboxAnswer,
  type InboxEntry,
  type InboxState,
} from "@novadeck/core/inbox"
import { inboxMarks } from "@novadeck/core/inbox/marks"
import { createStore, createWorkspaceStore } from "@novadeck/core/store"
import { appearance, workspaceFixture } from "@novadeck/core/testing"
import type { AgentStatus } from "@novadeck/core/types"
import { afterEach, beforeEach, vi } from "vitest"

import { needing } from "../inbox/inbox-state"
import { context, describe, expect, it } from "../test"
import { decideHold, holdMs, landInbox, type HoldFacts } from "./inbox-landing"
import { followNeeds } from "./inbox-pings"
import { createUiStore, initialUi } from "./ui-store"

const target = { projectId: "project", workspaceSessionId: "initial" }

const source = (terminalId: string): InboxEntry["source"] => ({
  ...target,
  terminalId,
  handle: "moth",
  agent: "claude",
  title: "Checkout",
  projectName: "Project",
})

const ask = (id: string, terminalId: string): InboxEntry => ({
  id,
  source: source(terminalId),
  at: 1,
  stopped: true,
  seen: false,
  kind: "ask",
  ask: { subject: "Which?", body: "", details: null, hardToUndo: null, shape: { type: "text" } },
})

const done = (id: string, terminalId: string): InboxEntry => ({
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
        screenReader: "auto",
        chatView: false,
        agentAvatars: false,
        onboardingTour: false,
        appScale: 100,
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
  const { inbox, start } = landInbox(raw, workspace, ui, {
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
    answers,
    set: (items: InboxEntry[]) => void state.update((current) => ({ ...current, items })),
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
    // What the agent of terminal `terminalId` reports now.
    agent: (terminalId: string, agent: AgentStatus) =>
      workspace.dispatch({
        type: "terminal/status",
        target,
        terminalId,
        status: { state: "running", agent },
      }),
    focus: (pageFocused: boolean) => void ui.update((current) => ({ ...current, pageFocused })),
    ids: () => inbox.state.getSnapshot().items.map((entry) => entry.id),
  }
}

// Whether the landed entry `id` landed quietly.
const quietly = (inbox: ReturnType<typeof setup>["inbox"], id: string): boolean =>
  inbox.landedQuietly(inbox.state.getSnapshot().items.find((entry) => entry.id === id)!)

describe("the landing rule", () => {
  context("an entry of the terminal being viewed", () => {
    it("lands at once, quietly, beside one of another terminal that lands as any entry does", () => {
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

    it("lands as any entry does while the page hasn't their focus", () => {
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

    it("lands a newer entry under the same id as another: quietly only if still viewed", () => {
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

    it("lands at once, quietly, and isn't read however long the person looks", () => {
      const { set, select, inbox, ids, answers, stop } = setup()
      set([done("d", "01"), done("e", "02")])
      expect(ids()).toEqual(["d", "e"])
      expect(quietly(inbox, "d")).toBe(true)
      vi.advanceTimersByTime(60_000)
      select("02")
      vi.advanceTimersByTime(60_000)
      expect(answers).toEqual([])
      expect(inbox.state.getSnapshot().items.every((entry) => !entry.settled)).toBe(true)
      stop()
    })

    it("shows resolved once it was read in the Inbox, as history", () => {
      const { set, ids, inbox, stop } = setup()
      set([done("d", "01")])
      set([{ ...done("d", "01"), settled: { how: "read", at: Date.now() } }])
      expect(ids()).toEqual(["d"])
      expect(inbox.state.getSnapshot().items[0]?.settled).toMatchObject({ how: "read" })
      stop()
    })
  })

  context("what rings for the entries that land", () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    const follow = () => {
      const made = setup()
      const rung: string[] = []
      const unfollow = followNeeds(made.inbox, {
        graceMs: 100,
        ring: (entry) => rung.push(entry.id) > 0,
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

  context("a new ask of the terminal being viewed, whose agent works", () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    // The ask lands while its agent works on, as it does mid-turn.
    const asked = (id = "a", terminal = "01") => {
      const made = setup()
      made.agent(terminal, { working: true })
      const entry = { ...ask(id, terminal), at: Date.now() }
      made.set([entry])
      return { ...made, entry }
    }
    const counted = (made: ReturnType<typeof setup>): string[] =>
      needing(made.inbox.state.getSnapshot().items).map((entry) => entry.id)

    it("shows in the list but counts nowhere: not on the bell, not on the terminal's marks", () => {
      const made = asked()
      expect(made.ids()).toEqual(["a"])
      expect(made.inbox.state.getSnapshot().items[0]?.heldBack).toBe(true)
      expect(counted(made)).toEqual([])
      expect(
        inboxMarks(made.inbox.state.getSnapshot().items, { ...target, terminalId: "01" }, 0).need,
      ).toBeUndefined()
      made.stop()
    })

    it("counts, quietly, once the agent's words follow the ask", () => {
      const made = asked()
      made.agent("01", { working: true, wordsAt: Date.now() + 1 })
      expect(counted(made)).toEqual(["a"])
      expect(quietly(made.inbox, "a")).toBe(true)
      made.stop()
    })

    it("is held on by words from before the ask: a text before its tool call is no answer", () => {
      const made = asked()
      made.agent("01", { working: true, wordsAt: made.entry.at })
      expect(counted(made)).toEqual([])
      made.agent("01", { working: true, wordsAt: made.entry.at - 5 })
      expect(counted(made)).toEqual([])
      made.stop()
    })

    it("counts, quietly, once the agent's turn ends", () => {
      const made = asked()
      made.agent("01", { working: false })
      expect(counted(made)).toEqual(["a"])
      expect(quietly(made.inbox, "a")).toBe(true)
      made.stop()
    })

    it("counts, quietly, once the cap has passed, though nothing else changes", () => {
      const made = asked()
      vi.advanceTimersByTime(holdMs - 1)
      expect(counted(made)).toEqual([])
      vi.advanceTimersByTime(1)
      expect(counted(made)).toEqual(["a"])
      expect(quietly(made.inbox, "a")).toBe(true)
      made.stop()
    })

    it("counts, quietly, once the turn ended though background subagents keep it working", () => {
      const made = asked()
      made.agent("01", { working: true, lastTurn: { outcome: "completed", at: made.entry.at - 1 } })
      expect(counted(made)).toEqual([])
      made.agent("01", { working: true, lastTurn: { outcome: "completed", at: made.entry.at + 1 } })
      expect(counted(made)).toEqual(["a"])
      expect(quietly(made.inbox, "a")).toBe(true)
      made.stop()
    })

    it("arms the cap again when its timer fired before the clock reached it", () => {
      const made = asked()
      const real = Date.now()
      const lagging = vi.spyOn(Date, "now").mockReturnValue(real)
      vi.advanceTimersByTime(holdMs)
      expect(counted(made)).toEqual([])
      expect(vi.getTimerCount()).toBe(1)
      lagging.mockRestore()
      vi.advanceTimersByTime(holdMs)
      expect(counted(made)).toEqual(["a"])
      made.stop()
    })

    it("lands as an entry that landed elsewhere when the person looks away", () => {
      const made = asked()
      made.select("02")
      expect(counted(made)).toEqual(["a"])
      expect(quietly(made.inbox, "a")).toBe(false)
      made.stop()
    })

    it("lands unhushed when the page loses their focus", () => {
      const made = asked()
      made.focus(false)
      expect(counted(made)).toEqual(["a"])
      expect(quietly(made.inbox, "a")).toBe(false)
      made.stop()
    })

    it("rings after the grace when they look away, and never when its words come first", () => {
      const rings = (release: (made: ReturnType<typeof setup>) => void): string[] => {
        const made = asked()
        const rung: string[] = []
        const unfollow = followNeeds(made.inbox, {
          graceMs: 100,
          ring: (entry) => rung.push(entry.id) > 0,
          leave: () => {},
        })
        release(made)
        vi.advanceTimersByTime(500)
        unfollow()
        made.stop()
        return rung
      }
      expect(rings((made) => made.select("02"))).toEqual(["a"])
      expect(rings((made) => made.agent("01", { working: true, wordsAt: Date.now() + 1 }))).toEqual(
        [],
      )
      expect(rings(() => vi.advanceTimersByTime(holdMs))).toEqual([])
    })

    it("is held again from nothing when a newer ask comes under the same id", () => {
      const made = asked()
      made.agent("01", { working: false })
      made.agent("01", { working: true })
      made.set([{ ...ask("a", "01"), at: Date.now() + 1 }])
      expect(counted(made)).toEqual([])
      made.stop()
    })

    it("leaves no timer behind once it is answered or the landing stops", () => {
      const made = asked()
      made.set([])
      expect(vi.getTimerCount()).toBe(0)
      made.set([{ ...ask("b", "01"), at: Date.now() }])
      expect(vi.getTimerCount()).toBe(1)
      made.stop()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  context("what is not held", () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    it("an ask of a terminal the person doesn't look at", () => {
      const made = setup()
      made.agent("02", { working: true })
      made.set([{ ...ask("a", "02"), at: Date.now() }])
      expect(needing(made.inbox.state.getSnapshot().items)).toHaveLength(1)
      expect(quietly(made.inbox, "a")).toBe(false)
      made.stop()
    })

    it("an ask whose agent doesn't work: there are no words to wait for", () => {
      const made = setup()
      made.agent("01", { working: false })
      made.set([{ ...ask("a", "01"), at: Date.now() }])
      expect(needing(made.inbox.state.getSnapshot().items)).toHaveLength(1)
      made.stop()
    })

    it("an ask of a terminal whose agent says nothing of itself", () => {
      const made = setup()
      made.set([{ ...ask("a", "01"), at: Date.now() }])
      expect(needing(made.inbox.state.getSnapshot().items)).toHaveLength(1)
      made.stop()
    })

    it("an ask the Inbox held long before, as it fills in after a launch", () => {
      const made = setup()
      made.agent("01", { working: true })
      made.set([{ ...ask("a", "01"), at: Date.now() - holdMs - 1 }])
      expect(needing(made.inbox.state.getSnapshot().items)).toHaveLength(1)
      made.stop()
    })

    it("an entry that is no ask: an update lands as it does", () => {
      const made = setup()
      made.agent("01", { working: true })
      made.set([{ ...done("d", "01"), at: Date.now() }])
      expect(made.inbox.state.getSnapshot().items[0]?.heldBack).toBeUndefined()
      expect(quietly(made.inbox, "d")).toBe(true)
      made.stop()
    })

    it("a resolved ask", () => {
      const made = setup()
      made.agent("01", { working: true })
      made.set([
        { ...ask("a", "01"), at: Date.now(), settled: { how: "dismissed", at: Date.now() } },
      ])
      expect(made.inbox.state.getSnapshot().items[0]?.heldBack).toBeUndefined()
      made.stop()
    })

    it("an ask on a phone, while the Inbox list covers the screen", () => {
      const made = setup(false)
      made.agent("01", { working: true })
      made.showList()
      made.set([{ ...ask("a", "01"), at: Date.now() }])
      expect(needing(made.inbox.state.getSnapshot().items)).toHaveLength(1)
      made.stop()
    })
  })

  context("on a phone, while the Inbox list covers the screen", () => {
    it("lands it as any entry: no terminal counts as viewed", () => {
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

describe("deciding the hold on an ask", () => {
  const facts: HoldFacts = {
    ask: true,
    here: true,
    landed: false,
    holding: false,
    fresh: true,
    working: true,
    said: false,
    capped: false,
  }

  it("holds a new, fresh ask of a viewed terminal whose agent works and hasn't spoken", () => {
    expect(decideHold(facts)).toBe(true)
  })

  it("keeps holding what it held, though it is no longer fresh", () => {
    expect(decideHold({ ...facts, fresh: false })).toBe(false)
    expect(decideHold({ ...facts, fresh: false, holding: true })).toBe(true)
  })

  it("ends at the agent's words, its turn's end, the cap and the person looking away", () => {
    for (const end of [{ said: true }, { working: false }, { capped: true }, { here: false }])
      expect(decideHold({ ...facts, holding: true, ...end })).toBe(false)
  })

  it("holds no entry that isn't an ask, or that landed already", () => {
    expect(decideHold({ ...facts, ask: false })).toBe(false)
    expect(decideHold({ ...facts, landed: true })).toBe(false)
  })
})
