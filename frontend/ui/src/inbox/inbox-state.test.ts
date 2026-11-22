import { ordered, type InboxEntry } from "@novadeck/core/inbox"

import { context, describe, expect, it } from "../test"
import {
  clearArrived,
  closeSheet,
  held,
  initialView,
  keptOrder,
  needing,
  needs,
  nextEntry,
  openEntry,
  rearranged,
  release,
  settle,
  stepFrom,
  visible,
} from "./inbox-state"

const source: InboxEntry["source"] = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "t",
  handle: "moth",
  agent: "claude",
  title: "Title",
  projectName: "Project",
}

// A permission that waited since `at`.
const approve = (id: string, at: number, stopped = true): InboxEntry => ({
  id,
  source,
  at,
  stopped,
  seen: false,
  kind: "request",
  request: {
    id,
    kind: "permission",
    tool: "Bash",
    subject: id,
    choices: [],
    subagent: false,
    dialog: null,
    answered: false,
    askedAt: 0,
  },
})
const update = (id: string, at: number): InboxEntry => ({
  id,
  source,
  at,
  stopped: false,
  seen: false,
  kind: "update",
  update: { type: "told", subject: id, body: "" },
})

const ids = (entries: readonly InboxEntry[]): string[] => entries.map(({ id }) => id)

// The person's order keeps entries by their key, an id and when it began: the entries below began
// at 3, 2 and 1 (a, b, c).
const keyed = (...names: string[]): string[] =>
  names.map((name) => ({ a: "a@3", b: "b@2", c: "c@1" })[name] ?? name)

describe("What the Inbox starts with", () => {
  it("is on the list at once, and none of it counts as having just arrived", () => {
    const entries = [approve("a", 2), approve("b", 1)]
    const view = settle(initialView, entries)

    expect(ids(visible(view, entries))).toEqual(["a", "b"])
    expect(view.arrived).toEqual([])
  })
})

describe("An Inbox entry that arrives with no sheet open", () => {
  it("joins the list and is marked as arrived until the mark is cleared", () => {
    const before = [approve("b", 1)]
    const now = [...before, approve("a", 2)]
    const view = settle(settle(initialView, before), now)

    expect(ids(visible(view, now))).toEqual(["a", "b"])
    expect(view.arrived).toEqual(["a"])
    expect(clearArrived(view).arrived).toEqual([])
  })

  it("leaves the view as it was when nothing changed", () => {
    const entries = [approve("a", 1)]
    const view = settle(initialView, entries)

    expect(settle(view, entries)).toBe(view)
  })
})

describe("An Inbox entry that arrives while a sheet is open", () => {
  const before = [approve("a", 3), approve("b", 2)]
  const arrival = approve("c", 4)
  const now = [...before, arrival]
  const open = openEntry(settle(initialView, before), "a", before)

  it("is held, so the list neither grows nor reorders", () => {
    expect(ids(visible(open, now))).toEqual(["a", "b"])
    expect(ids(held(open, now))).toEqual(["c"])
    expect(settle(open, now)).toBe(open)
  })

  it("joins, marked, when the sheet closes", () => {
    const closed = closeSheet(open, now)

    expect(closed.open).toBeNull()
    expect(ids(visible(closed, now))).toEqual(["c", "a", "b"])
    expect(closed.arrived).toEqual(["c"])
  })

  it("joins, marked, when asked to while the sheet stays open", () => {
    const released = release(open, now)

    expect(released.open).toBe("a")
    expect(ids(visible(released, now))).toEqual(["c", "a", "b"])
    expect(ids(held(released, now))).toEqual([])
    expect(released.arrived).toEqual(["c"])
  })

  it("keeps showing an entry the person answered, until the backend drops it", () => {
    expect(ids(visible(open, [before[1]!, arrival]))).toEqual(["a", "b"])
  })

  it("keeps an entry the Inbox no longer lists, as it was, and one a newer entry took the id of", () => {
    const retaken = { ...before[0]!, at: 99 }
    expect(ids(visible(open, [before[1]!]))).toEqual(["a", "b"])
    const shown = visible(open, [retaken, before[1]!])
    expect(shown.map(({ at }) => at)).toEqual([3, 2])
  })

  it("keeps resolved entries past the ten, and the earlier copy of a held entry, until the sheet closes", () => {
    const resolved = Array.from({ length: 10 }, (_, index) => ({
      ...approve(`r${index}`, 100 + index),
      settled: { how: "answered" as const, at: 200 + index },
    }))
    const entries = [approve("a", 300), ...resolved]
    const frozen = openEntry(settle(initialView, entries), "a", entries)
    const newer = { ...resolved[0]!, id: "z", at: 400, settled: { how: "read" as const, at: 999 } }
    // Ten resolved entries are listed at most: the oldest goes, but not from the open list.
    const capped = ordered([entries[0]!, ...resolved.slice(1), newer])
    expect(ids(visible(frozen, capped)).toSorted()).toEqual(ids(entries).toSorted())
    expect(ids(visible({ ...frozen, open: null }, capped))).not.toContain("r0")
  })
})

describe("The list while a sheet is open", () => {
  it("keeps its order, whatever happens to the urgency of an entry", () => {
    const before = [approve("a", 3), approve("b", 2), approve("c", 1)]
    const open = openEntry(settle(initialView, before), "c", before)
    // "b" is asked again, a newer entry under its id, which moves it up in the Inbox's own order.
    const now = [before[0]!, approve("b", 4), before[2]!]

    expect(ids(visible(open, now))).toEqual(["a", "b", "c"])
    expect(ids(visible({ ...open, open: null }, now))).toEqual(["b", "a", "c"])
  })

  it("keeps the place of an entry that was answered and is gone", () => {
    const before = [approve("a", 2), approve("b", 1)]
    const open = openEntry(settle(initialView, before), "a", before)

    expect(ids(visible(open, [before[1]!], { a: before[0]! }))).toEqual(["a", "b"])
  })
})

describe("The list", () => {
  it("orders the entry added last first, whatever it asks", () => {
    const entries = [update("u", 1), approve("late", 9), approve("early", 2)]

    expect(ids(visible(initialView, entries))).toEqual(["late", "early", "u"])
  })
})

describe("What asks next", () => {
  const entries = [approve("a", 3), approve("b", 2), update("u", 0), approve("c", 1, false)]

  it("is the newest entry other than the one answered", () => {
    expect(nextEntry(entries, "a", { answering: {} })?.id).toBe("b")
    expect(nextEntry(entries, "b", { answering: {} })?.id).toBe("a")
  })

  it("skips entries whose answer is on its way, and updates", () => {
    expect(nextEntry(entries, "a", { answering: { b: true } })?.id).toBe("c")
    expect(nextEntry([update("u", 0)], null, { answering: {} })).toBeUndefined()
  })
})

describe("Stepping down and up the list", () => {
  const entries = [approve("a", 3), approve("b", 2), approve("c", 1)]

  it("moves an entry at a time and stops at the ends", () => {
    expect(stepFrom(entries, "a", 1)?.id).toBe("b")
    expect(stepFrom(entries, "c", 1)?.id).toBe("c")
    expect(stepFrom(entries, "a", -1)?.id).toBe("a")
  })

  it("starts at the first when nothing is open", () => {
    expect(stepFrom(entries, null, 1)?.id).toBe("a")
    expect(stepFrom(entries, null, -1)?.id).toBe("a")
  })
})

describe("What the rail counts", () => {
  context("with updates among the entries", () => {
    it("leaves them out", () => {
      expect(ids(needing([approve("a", 1), update("u", 2)]))).toEqual(["a"])
    })
  })

  context("when stepping to the next entry", () => {
    it("skips an update, which asks nothing", () => {
      expect(nextEntry([update("u", 3), approve("a", 2)], null, { answering: {} })?.id).toBe("a")
      expect(nextEntry([update("u", 3)], null, { answering: {} })).toBeUndefined()
    })
  })
})

// An ask the agent wrote, open or settled `how` at `at`.
const ask = (
  id: string,
  at: number,
  settled?: { how: "dismissed" | "replied"; at: number },
): InboxEntry => ({
  id,
  source,
  at,
  stopped: !settled,
  seen: false,
  kind: "ask",
  ask: {
    subject: id,
    body: "",
    details: null,
    hardToUndo: null,
    shape: { type: "text" },
  },
  ...(settled ? { settled } : {}),
})

describe("An ask the landing rule holds back", () => {
  it("asks nothing yet: the bell and the count leave it out, while the list keeps it", () => {
    const heldBack: InboxEntry = { ...ask("a", 1), heldBack: true }
    expect(needs(heldBack)).toBe(false)
    expect(ids(needing([heldBack, ask("b", 2)]))).toEqual(["b"])
    expect(ids(ordered([heldBack, ask("b", 2)]))).toEqual(["b", "a"])
  })
})

describe("An entry that is resolved", () => {
  const entries = [ask("a", 2), ask("b", 1, { how: "dismissed", at: 9 })]

  it("is not held as news while a sheet is open", () => {
    const open = openEntry(settle(initialView, [entries[0]!]), "a", [entries[0]!])
    expect(ids(held(open, entries))).toEqual([])
  })

  it("asks nothing: the count, the bell and the rings leave it out", () => {
    expect(needs(entries[1]!)).toBe(false)
    expect(ids(needing(entries))).toEqual(["a"])
  })

  it("is never what asks next", () => {
    expect(nextEntry(entries, null, { answering: {} })?.id).toBe("a")
    expect(nextEntry([entries[1]!], null, { answering: {} })).toBeUndefined()
  })

  it("lists with the rest, the newest first by when each was added", () => {
    const all = [ask("c", 3, { how: "replied", at: 5 }), entries[1]!, update("u", 4), entries[0]!]

    expect(ids(visible(settle(initialView, all), all))).toEqual(["u", "c", "a", "b"])
  })

  it("keeps its place while the panel is on screen, among the entries the person arranged", () => {
    const open = [ask("a", 3), ask("b", 2), ask("c", 1)]
    const view = settle(initialView, open, true)
    const after = [open[0]!, ask("b", 2, { how: "dismissed", at: 9 }), open[2]!]
    const placed = keyed("c", "b", "a")

    expect(ids(visible(settle(view, after, true), after, {}, placed))).toEqual(["c", "b", "a"])
  })

  it("does not move when a sheet closes with the panel still on screen", () => {
    const open = [ask("a", 3), ask("b", 2), update("u", 1)]
    let view = settle(initialView, open, true)
    view = openEntry(view, "a", open)
    const after = [open[0]!, ask("b", 2, { how: "dismissed", at: 9 }), open[2]!]
    view = settle(view, after, true)

    expect(ids(visible(closeSheet(view, after), after))).toEqual(["a", "b", "u"])
  })
})

describe("The entries that ask, in the person's order", () => {
  const items = [approve("a", 3), approve("b", 2), approve("c", 1), update("u", 0)]

  it("keep the Inbox's own order, the newest first, until the person drags them", () => {
    expect(ids(visible(initialView, items, {}, []))).toEqual(["a", "b", "c", "u"])
  })

  it("follow it, the updates keeping their places", () => {
    expect(ids(visible(initialView, items, {}, keyed("c", "a", "b")))).toEqual(["c", "a", "b", "u"])
  })

  it("put one that comes after ahead of the ones the person put in order", () => {
    const later = [...items, approve("d", 9)]

    expect(ids(visible(initialView, later, {}, keyed("b", "c", "a")))).toEqual([
      "d",
      "b",
      "c",
      "a",
      "u",
    ])
  })

  it("leave the resolved entries where they are, beside the entries that were put in order", () => {
    const mixed = [...items, ask("r", 2.5, { how: "dismissed", at: 9 })]

    expect(ids(visible(initialView, mixed, {}, keyed("c", "b", "a")))).toEqual([
      "c",
      "r",
      "b",
      "a",
      "u",
    ])
  })

  it("take an entry asked again under the same id as new, not where the old one was put", () => {
    // "a" was put last and answered; the harness asks the same again, an entry under its id.
    const again = [approve("a", 7), approve("b", 2), approve("c", 1)]
    expect(ids(visible(initialView, again, {}, keyed("b", "c", "a")))).toEqual(["a", "b", "c"])
  })

  it("forget the entries that have gone", () => {
    expect(ids(visible(initialView, items, {}, keyed("gone", "b", "a")))).toEqual([
      "c",
      "b",
      "a",
      "u",
    ])
  })

  it("set what asks next", () => {
    expect(nextEntry(items, "c", { answering: {} }, keyed("c", "b", "a"))?.id).toBe("b")
  })

  it("move in the list an open sheet holds still, in the places they had", () => {
    const open = openEntry(settle(initialView, items), "a", items)
    const moved = rearranged(open, ["c", "b", "a"])

    expect(ids(visible(moved, items))).toEqual(["c", "b", "a", "u"])
    // With no sheet open the list follows the order itself.
    const closed = { ...open, open: null }
    expect(rearranged(closed, ["c", "b", "a"])).toBe(closed)
  })
})

describe("A snoozed entry", () => {
  const snoozed = (entry: InboxEntry): InboxEntry => ({ ...entry, snoozed: true })
  const items = [approve("a", 3), snoozed(approve("b", 2)), approve("c", 1), update("u", 0)]

  it("asks nothing now: the count, the bell and the rings leave it out", () => {
    expect(needs(items[1]!)).toBe(false)
    expect(ids(needing(items))).toEqual(["a", "c"])
  })

  it("is never what asks next", () => {
    expect(nextEntry(items, "a", { answering: {} })?.id).toBe("c")
    expect(nextEntry([items[1]!], null, { answering: {} })).toBeUndefined()
  })

  it("keeps its place, and the person's order moves it like any entry that asks", () => {
    expect(ids(visible(initialView, items))).toEqual(["a", "b", "c", "u"])
    expect(ids(visible(initialView, items, {}, keyed("b", "c", "a")))).toEqual(["b", "c", "a", "u"])
  })
})

describe("The order after a drag", () => {
  it("keeps the place of an entry the list didn't show, after the entries it followed", () => {
    // "x" was put last; it is hidden while the person looks at its terminal, and they drag
    // "c" to the top meanwhile.
    expect(keptOrder(["a", "b", "c", "x"], ["c", "a", "b"])).toEqual(["c", "a", "b", "x"])
    expect(keptOrder(["x", "a", "b"], ["b", "a"])).toEqual(["x", "b", "a"])
    expect(keptOrder(["a", "x", "b"], ["b", "a"])).toEqual(["b", "a", "x"])
  })

  it("is the drag's own order where nothing was hidden", () => {
    expect(keptOrder(["a", "b"], ["b", "a"])).toEqual(["b", "a"])
    expect(keptOrder([], ["b", "a"])).toEqual(["b", "a"])
  })
})
