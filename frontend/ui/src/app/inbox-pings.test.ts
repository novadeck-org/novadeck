import { emptyInbox, type InboxRow, type InboxState } from "@novadeck/core/inbox"
import type { Notice } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import { appearance } from "@novadeck/core/testing"
import { afterEach, beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { createDing } from "./ding"
import {
  clickNotice,
  needNotice,
  noticeBoard,
  watchBellRings,
  watchInboxPings,
} from "./inbox-pings"
import { createUiStore, initialUi } from "./ui-store"

// A ding that sounds nothing: the board under test is about its notices.
const testDing = createDing({ sound: () => ({ on: false, volume: 0, name: "felt" }) })

const source: InboxRow["source"] = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "t1",
  handle: "moth",
  agent: "claude",
  title: "Checkout",
  projectName: "Project",
}

const request = (id: string, tool: string, subject: string | null, at = Date.now()): InboxRow => ({
  id,
  source,
  at,
  stopped: true,
  seen: false,
  kind: "request",
  request: {
    id,
    kind: "permission",
    tool,
    subject,
    choices: [],
    subagent: false,
    dialog: null,
    answered: false,
  },
})

const ask = (id: string, at = Date.now()): InboxRow => ({
  id,
  source,
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

const update = (id: string, at = Date.now()): InboxRow => ({
  id,
  source,
  at,
  stopped: false,
  seen: false,
  kind: "update",
  update: { type: "told", subject: "Done", body: "" },
})

const backgrounded = (notifyNeeds = true) => {
  const base = initialUi({
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
      enabledViews: ["focus"],
      appearance,
      notifyNeeds,
      notifyFinished: true,
      sound: true,
      soundVolume: 0.6,
      soundChoice: "theme",
      ligatures: false,
      chatView: false,
    },
  })
  return createUiStore({ ...base, pageFocused: false })
}

const setup = (
  options: {
    notifyNeeds?: boolean
    items?: InboxRow[]
    graceMs?: number
    drawn?: boolean
  } = {},
) => {
  const { notifyNeeds = true, items = [], graceMs = 2000, drawn = true } = options
  const inbox = createStore<InboxState>({ ...emptyInbox, items })
  const ui = backgrounded(notifyNeeds)
  const shown: Notice[] = []
  const closed: string[] = []
  const badges: { count: number; image: string | null }[] = []
  const board = noticeBoard(
    {
      show: (notice) => void shown.push(notice),
      close: (terminalId) => void closed.push(terminalId),
      onClick: () => () => {},
    },
    testDing,
  )!
  const images: number[] = []
  const stop = watchInboxPings({ state: inbox }, ui, {
    board,
    badge: (badge) => void badges.push(badge),
    graceMs,
    ...(drawn && {
      image: (count: number) => {
        images.push(count)
        return `data:image/png;base64,${count}`
      },
    }),
  })
  const set = (next: InboxRow[]) => inbox.update((state) => ({ ...state, items: next }))
  const focus = (pageFocused: boolean) => ui.update((state) => ({ ...state, pageFocused }))
  return { set, focus, shown, closed, badges, images, board, stop }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
})
afterEach(() => void vi.useRealTimers())

describe("pings for what needs the person", () => {
  context("when a new row needs them while Novadeck is in the background", () => {
    it("sends one notification once the grace has passed", () => {
      const { set, shown, stop } = setup()
      set([request("a", "Bash", "pnpm test")])
      vi.advanceTimersByTime(1999)
      expect(shown).toEqual([])
      vi.advanceTimersByTime(1)
      expect(shown).toEqual([
        {
          id: "t1",
          title: "@moth wants to run a command: Checkout",
          body: "Run pnpm test?",
          silent: true,
        },
      ])
      stop()
    })

    it("sends none for a row that is answered or withdrawn within the grace", () => {
      const { set, shown, stop } = setup()
      set([request("a", "Bash", "ls")])
      vi.advanceTimersByTime(1000)
      set([])
      vi.advanceTimersByTime(5000)
      expect(shown).toEqual([])
      stop()
    })

    it("sends none when the person focuses Novadeck within the grace, or when they don't want them", () => {
      const first = setup()
      first.set([ask("a")])
      vi.advanceTimersByTime(1000)
      first.focus(true)
      vi.advanceTimersByTime(5000)
      expect(first.shown).toEqual([])
      first.stop()

      const second = setup({ notifyNeeds: false })
      second.set([ask("a")])
      vi.advanceTimersByTime(5000)
      expect(second.shown).toEqual([])
      second.stop()
    })

    it("sends none for an update, which doesn't need them", () => {
      const { set, shown, stop } = setup()
      set([update("u")])
      vi.advanceTimersByTime(5000)
      expect(shown).toEqual([])
      stop()
    })

    it("sends one for each row, once, however often the Inbox changes meanwhile", () => {
      const { set, shown, stop } = setup()
      const first = ask("a")
      set([first])
      vi.advanceTimersByTime(2000)
      set([first, update("u")])
      set([{ ...first, seen: true }])
      vi.advanceTimersByTime(5000)
      expect(shown).toHaveLength(1)
      stop()
    })
  })

  context("when Novadeck has the person's focus", () => {
    it("sends none", () => {
      const { set, focus, shown, stop } = setup()
      focus(true)
      set([ask("a")])
      vi.advanceTimersByTime(5000)
      expect(shown).toEqual([])
      stop()
    })
  })

  context("when it starts", () => {
    it("takes the rows already there as seen, and any that began well before it", () => {
      const there = ask("a")
      const { set, shown, stop } = setup({ items: [there] })
      vi.advanceTimersByTime(5000)
      expect(shown).toEqual([])
      const old = ask("old", 4000)
      set([there, old])
      vi.advanceTimersByTime(5000)
      expect(shown).toEqual([])
      set([there, old, request("b", "Edit", "src/a.ts", 15_000)])
      vi.advanceTimersByTime(2000)
      expect(shown).toHaveLength(1)
      stop()
    })
  })

  context("when it started just after a request was asked", () => {
    it("pings for the request once its row shows", () => {
      const { set, shown, stop } = setup()
      set([request("a", "Bash", "ls", 8000)])
      vi.advanceTimersByTime(2000)
      expect(shown).toHaveLength(1)
      stop()
    })
  })

  context("when a row leaves before it pinged and comes back", () => {
    it("waits out its whole grace again", () => {
      const { set, shown, stop } = setup()
      const row = ask("a")
      set([row])
      vi.advanceTimersByTime(1000)
      set([])
      vi.advanceTimersByTime(500)
      set([row])
      vi.advanceTimersByTime(1999)
      expect(shown).toEqual([])
      vi.advanceTimersByTime(1)
      expect(shown).toHaveLength(1)
      stop()
    })
  })

  context("when a row that pinged leaves the Inbox", () => {
    it("takes its notification back once it has stayed gone for the grace", () => {
      const { set, shown, closed, stop } = setup()
      set([ask("a")])
      vi.advanceTimersByTime(2000)
      expect(shown).toHaveLength(1)
      set([])
      vi.advanceTimersByTime(1999)
      expect(closed).toEqual([])
      vi.advanceTimersByTime(1)
      expect(closed).toEqual(["t1"])
      stop()
    })

    it("keeps it for one that drops out of a recompute and comes back", () => {
      const { set, shown, closed, stop } = setup()
      const row = ask("a")
      set([row])
      vi.advanceTimersByTime(2000)
      set([])
      vi.advanceTimersByTime(500)
      set([row])
      vi.advanceTimersByTime(5000)
      expect(closed).toEqual([])
      expect(shown).toHaveLength(1)
      stop()
    })

    it("pings again for one that comes back after its notification went", () => {
      const { set, shown, closed, stop } = setup()
      const row = ask("a")
      set([row])
      vi.advanceTimersByTime(2000)
      set([])
      vi.advanceTimersByTime(2000)
      expect(closed).toEqual(["t1"])
      set([row])
      vi.advanceTimersByTime(2000)
      expect(shown).toHaveLength(2)
      stop()
    })

    it("takes back nothing for one that never pinged, or once a newer notification replaced it", () => {
      const { set, board, closed, stop } = setup()
      set([ask("a")])
      vi.advanceTimersByTime(1000)
      set([])
      expect(closed).toEqual([])

      set([ask("b")])
      vi.advanceTimersByTime(2000)
      board.show("finish", { id: "t1", title: "@moth is done: Checkout", body: "Done." })
      set([])
      vi.advanceTimersByTime(5000)
      expect(closed).toEqual([])
      stop()
    })

    it("treats a newer row under the same id as another", () => {
      const { set, shown, closed, stop } = setup()
      set([ask("a", 10_000)])
      vi.advanceTimersByTime(2000)
      vi.setSystemTime(20_000)
      set([ask("a", 20_000)])
      vi.advanceTimersByTime(2000)
      expect(closed).toEqual(["t1"])
      expect(shown).toHaveLength(2)
      stop()
    })
  })

  context("when it stops", () => {
    it("drops what waits and clears the badge", () => {
      const { set, shown, badges, stop } = setup()
      set([ask("a")])
      stop()
      vi.advanceTimersByTime(5000)
      expect(shown).toEqual([])
      expect(badges.at(-1)).toEqual({ count: 0, image: null })
    })
  })
})

describe("the bell's rings, which its dot rings with", () => {
  const follow = (items: InboxRow[] = []) => {
    const inbox = createStore<InboxState>({ ...emptyInbox, items })
    const ui = backgrounded()
    // Focused, as the toast's case: the bell rings whichever doorbell takes the row.
    ui.update((state) => ({ ...state, pageFocused: true }))
    const stop = watchBellRings({ state: inbox }, ui, { graceMs: 2000 })
    const set = (next: InboxRow[]) => inbox.update((state) => ({ ...state, items: next }))
    return { set, rings: () => ui.getSnapshot().bellRings, stop }
  }

  it("counts each new row that needs the person, once its grace has passed", () => {
    const { set, rings, stop } = follow()
    const first = ask("a")
    set([first])
    vi.advanceTimersByTime(1999)
    expect(rings()).toBe(0)
    vi.advanceTimersByTime(1)
    expect(rings()).toBe(1)
    const second = request("b", "Bash", "pnpm test")
    set([first, second])
    set([first, second])
    vi.advanceTimersByTime(2000)
    expect(rings()).toBe(2)
    stop()
  })

  it("counts none for what was there as it started, began well before, or doesn't call", () => {
    const { set, rings, stop } = follow([ask("there")])
    set([ask("there"), ask("old", 4000), update("u")])
    vi.advanceTimersByTime(5000)
    expect(rings()).toBe(0)
    stop()
  })

  it("counts a new row that began before one already waiting", () => {
    const { set, rings, stop } = follow()
    vi.setSystemTime(300_000)
    const first = ask("a")
    set([first])
    vi.advanceTimersByTime(2000)
    // Messages held long become a row minutes after they began waiting.
    set([first, ask("held", 120_000)])
    vi.advanceTimersByTime(2000)
    expect(rings()).toBe(2)
    stop()
  })
})

describe("what a notification says of a row", () => {
  it("leads with who it is from, in the row's own words, and gives its subject as the body", () => {
    expect(needNotice(ask("a"))).toEqual({
      id: "t1",
      title: "@moth asks you: Checkout",
      body: "Which database?",
    })
    expect(needNotice(request("a", "Edit", "src/a.ts"))).toMatchObject({
      title: "@moth wants to edit a file: Checkout",
      body: "Edit src/a.ts?",
    })
    expect(needNotice(request("a", "Fetch", null))).toMatchObject({
      title: "@moth wants to use Fetch: Checkout",
      body: "Use Fetch?",
    })
  })

  it("is Novadeck's own for what Novadeck noticed, and plain where the terminal has no handle", () => {
    const failed: InboxRow = {
      id: "f",
      source,
      at: 0,
      stopped: true,
      seen: false,
      kind: "trouble",
      trouble: { type: "failed", error: null },
    }
    expect(needNotice(failed)).toEqual({
      id: "t1",
      title: "Novadeck noticed: Checkout",
      body: "Its turn ended in an error",
    })
    expect(needNotice({ ...ask("a"), source: { ...source, handle: "" } }).title).toBe(
      "Checkout asks you",
    )
  })
})

describe("the app icon's count", () => {
  it("follows the bell's count: what isn't an update, from the start, and 0 once none waits", () => {
    const { set, badges, stop } = setup({ items: [ask("a"), update("u")] })
    expect(badges).toEqual([{ count: 1, image: "data:image/png;base64,1" }])
    set([ask("a"), update("u"), update("v")])
    expect(badges).toHaveLength(1)
    set([ask("a"), ask("b"), update("u")])
    expect(badges.at(-1)).toEqual({ count: 2, image: "data:image/png;base64,2" })
    set([update("u")])
    expect(badges.at(-1)).toEqual({ count: 0, image: null })
    stop()
  })

  it("caps at 999", () => {
    const { set, badges, stop } = setup()
    set(Array.from({ length: 1200 }, (_, index) => ask(`a${index}`)))
    expect(badges.at(-1)?.count).toBe(999)
    stop()
  })

  it("draws no image where the platform takes none, as here", () => {
    const { set, badges, stop } = setup({ drawn: false })
    set([ask("a")])
    expect(badges).toEqual([
      { count: 0, image: null },
      { count: 1, image: null },
    ])
    stop()
  })
})

describe("the board of notifications", () => {
  context("with a ding", () => {
    const withDing = (on: boolean, sounds?: boolean) => {
      const shown: Notice[] = []
      const rung: string[] = []
      const taken: string[] = []
      const board = noticeBoard(
        {
          show: (notice) => void shown.push(notice),
          onClick: () => () => {},
          ...(sounds && { sounds }),
        },
        {
          on: () => on,
          sound: () => "afterglow",
          take: (key) => {
            taken.push(key)
            return on && key !== "again"
          },
          play: () => {},
          ring: (key) => void rung.push(key),
          preview: () => {},
        },
      )!
      for (const id of ["t", "u", "again"]) board.show("a", { id, title: "", body: "" })
      return { shown, rung, taken }
    }

    it("sounds a terminal's finish notice and its toast just after once, with the app's ding", async () => {
      const heard: number[] = []
      let clock = 1000
      const ding = createDing({
        sound: () => ({ on: true, volume: 0.6, name: "felt" }),
        audio: (volume) => ({ play: () => void heard.push(volume) }),
        now: () => clock,
      })
      const board = noticeBoard({ show: () => {}, onClick: () => () => {} }, ding)!
      board.show("finish", { id: "t", title: "", body: "" })
      // The terminal's question toasts once its grace has passed, as the toast rings it.
      clock += 2500
      ding.ring("t")
      // The sound waits on the system's check.
      await vi.advanceTimersByTimeAsync(0)
      expect(heard).toEqual([0.6])
    })

    it("sounds it by the notice's terminal", () => {
      expect(withDing(true).rung).toEqual(["t", "u", "again"])
    })

    it("leaves the sound to the desktop app where its notifications play it, keeping it to the ding's rules", () => {
      const { rung, taken, shown } = withDing(true, true)
      expect(rung).toEqual([])
      expect(taken).toEqual(["t", "u", "again"])
      expect(shown.map((notice) => notice.silent)).toEqual([false, false, true])
    })

    it("names the theme's sound on a notice for a desktop app that plays it", () => {
      expect(withDing(true, true).shown.map((notice) => notice.sound)).toEqual([
        "afterglow",
        "afterglow",
        "afterglow",
      ])
    })

    it("marks the notice silent when the person turned the sound off", () => {
      expect(withDing(false).shown.map((notice) => notice.silent)).toEqual([true, true, true])
      expect(withDing(true).shown.map((notice) => notice.silent)).toEqual([false, false, false])
      expect(withDing(false, true).shown.map((notice) => notice.silent)).toEqual([true, true, true])
    })
  })

  it("closes a terminal's notification only for the source that showed the latest", () => {
    const closed: string[] = []
    const board = noticeBoard(
      {
        show: () => {},
        close: (id) => void closed.push(id),
        onClick: () => () => {},
      },
      testDing,
    )!
    board.show("a", { id: "t", title: "", body: "" })
    board.show("b", { id: "t", title: "", body: "" })
    board.close("a", "t")
    expect(closed).toEqual([])
    board.close("b", "t")
    board.close("b", "t")
    expect(closed).toEqual(["t"])
  })

  it("remembers the row of a terminal's latest notice, one board per backend", () => {
    const notices = { show: () => {}, close: () => {}, onClick: () => () => {} }
    noticeBoard(notices, testDing)!.show("a", { id: "t", title: "", body: "" }, "first")
    noticeBoard(notices, testDing)!.show("b", { id: "t", title: "", body: "" }, "second")
    expect(noticeBoard(notices, testDing)!.rowIdOf("t")).toBe("second")
    noticeBoard(notices, testDing)!.close("b", "t")
    expect(noticeBoard(notices, testDing)!.rowIdOf("t")).toBeUndefined()
  })

  it("is none where there are no notifications", () => {
    expect(noticeBoard(undefined, testDing)).toBeUndefined()
  })
})

describe("a click on a terminal's notification", () => {
  const to = () => {
    const calls: string[] = []
    return {
      calls,
      open: (id: string) => void calls.push(`open ${id}`),
      showInbox: () => void calls.push("inbox"),
      reveal: (terminalId: string) => void calls.push(`reveal ${terminalId}`),
      land: (id: string) => void calls.push(`land ${id}`),
    }
  }

  it("skips a settled row, which has no sheet to open", () => {
    const { calls, ...handlers } = to()
    const settled = { ...ask("s"), settled: { how: "dismissed" as const, at: 2 } }
    clickNotice("t1", [settled, ask("a")], handlers)
    expect(calls).toEqual(["land a", "inbox", "open a"])
  })

  it("opens that terminal's row in the Inbox when one stands", () => {
    const { calls, ...handlers } = to()
    clickNotice("t1", [update("u"), ask("a")], handlers)
    expect(calls).toEqual(["land u", "inbox", "open u"])
  })

  it("opens the row the notice was about, among the terminal's several", () => {
    const { calls, ...handlers } = to()
    clickNotice("t1", [update("u"), ask("a"), update("v")], handlers, "v")
    expect(calls).toEqual(["land v", "inbox", "open v"])
  })

  it("opens the terminal's done report for a notice that names no row", () => {
    const { calls, ...handlers } = to()
    const finish: InboxRow = {
      ...update("f"),
      kind: "update",
      update: { type: "done", subject: "Done", body: "" },
    }
    clickNotice("t1", [ask("a"), update("u"), finish], handlers)
    expect(calls).toEqual(["land f", "inbox", "open f"])
  })

  it("falls back to the terminal's first row when the notice's row has left", () => {
    const { calls, ...handlers } = to()
    clickNotice("t1", [ask("a"), update("u")], handlers, "gone")
    expect(calls).toEqual(["land a", "inbox", "open a"])
  })

  it("shows the terminal otherwise", () => {
    const { calls, ...handlers } = to()
    clickNotice("t2", [ask("a")], handlers)
    expect(calls).toEqual(["reveal t2"])
  })
})

describe("the app icon's image on Windows", () => {
  afterEach(() => void vi.restoreAllMocks())

  it('is a circle with the count, "9+" past nine, drawn on a small canvas', () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32")
    const texts: string[] = []
    const drawing = new Proxy(
      {
        fillText: (text: string) => void texts.push(text),
      } as Partial<CanvasRenderingContext2D> as CanvasRenderingContext2D,
      {
        get: (target, key) => Reflect.get(target, key) ?? (() => {}),
        set: () => true,
      },
    )
    const create = document.createElement.bind(document)
    const canvas = create("canvas")
    vi.spyOn(canvas, "getContext").mockReturnValue(drawing)
    vi.spyOn(canvas, "toDataURL").mockReturnValue("data:image/png;base64,x")
    vi.spyOn(document, "createElement").mockImplementation((tag: string) =>
      tag === "canvas" ? canvas : create(tag),
    )
    const inbox = createStore<InboxState>({
      ...emptyInbox,
      items: Array.from({ length: 12 }, (_, index) => ask(`a${index}`)),
    })
    const badges: unknown[] = []
    const ui = backgrounded()
    watchInboxPings({ state: inbox }, ui, { badge: (badge) => void badges.push(badge) })()
    expect(texts).toEqual(["9+"])
    expect(canvas.width).toBe(32)
    expect(badges[0]).toEqual({ count: 12, image: "data:image/png;base64,x" })
  })
})
