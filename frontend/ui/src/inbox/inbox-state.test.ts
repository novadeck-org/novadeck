import type { InboxRow } from "@novadeck/core/inbox"

import { context, describe, expect, it } from "../test"
import {
  arrange,
  clearArrived,
  closeSheet,
  held,
  initialView,
  hasUpdates,
  keptOrder,
  needing,
  needs,
  nextRow,
  openRow,
  rearranged,
  release,
  settle,
  settledStart,
  stepFrom,
  updatesStart,
  visible,
} from "./inbox-state"

const source: InboxRow["source"] = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "t",
  handle: "moth",
  agent: "claude",
  title: "Title",
  projectName: "Project",
}

// A permission that waited since `at`.
const approve = (id: string, at: number, stopped = true): InboxRow => ({
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
  },
})
const update = (id: string, at: number): InboxRow => ({
  id,
  source,
  at,
  stopped: false,
  seen: false,
  kind: "update",
  update: { type: "told", subject: id, body: "" },
})

const ids = (rows: readonly InboxRow[]): string[] => rows.map(({ id }) => id)

// The person's order keeps rows by their key, an id and when it began: the rows below began
// at 1, 2 and 3 (a, b, c).
const keyed = (...names: string[]): string[] =>
  names.map((name) => ({ a: "a@1", b: "b@2", c: "c@3" })[name] ?? name)

describe("What the Inbox starts with", () => {
  it("is on the list at once, and none of it counts as having just arrived", () => {
    const rows = [approve("a", 1), approve("b", 2)]
    const view = settle(initialView, rows)

    expect(ids(visible(view, rows))).toEqual(["a", "b"])
    expect(view.arrived).toEqual([])
  })
})

describe("An Inbox row that arrives with no sheet open", () => {
  it("joins the list and is marked as arrived until the mark is cleared", () => {
    const before = [approve("a", 1)]
    const now = [...before, approve("b", 2)]
    const view = settle(settle(initialView, before), now)

    expect(ids(visible(view, now))).toEqual(["a", "b"])
    expect(view.arrived).toEqual(["b"])
    expect(clearArrived(view).arrived).toEqual([])
  })

  it("leaves the view as it was when nothing changed", () => {
    const rows = [approve("a", 1)]
    const view = settle(initialView, rows)

    expect(settle(view, rows)).toBe(view)
  })
})

describe("An Inbox row that arrives while a sheet is open", () => {
  const before = [approve("a", 1), approve("b", 2)]
  const arrival = approve("c", 3)
  const now = [...before, arrival]
  const open = openRow(settle(initialView, before), "a", before)

  it("is held, so the list neither grows nor reorders", () => {
    expect(ids(visible(open, now))).toEqual(["a", "b"])
    expect(ids(held(open, now))).toEqual(["c"])
    expect(settle(open, now)).toBe(open)
  })

  it("joins, marked, when the sheet closes", () => {
    const closed = closeSheet(open, now)

    expect(closed.open).toBeNull()
    expect(ids(visible(closed, now))).toEqual(["a", "b", "c"])
    expect(closed.arrived).toEqual(["c"])
  })

  it("joins, marked, when asked to while the sheet stays open", () => {
    const released = release(open, now)

    expect(released.open).toBe("a")
    expect(ids(visible(released, now))).toEqual(["a", "b", "c"])
    expect(ids(held(released, now))).toEqual([])
    expect(released.arrived).toEqual(["c"])
  })

  it("keeps showing a row the person answered, until the backend drops it", () => {
    expect(ids(visible(open, [before[1]!, arrival]))).toEqual(["b"])
  })
})

describe("The list while a sheet is open", () => {
  it("keeps its order, whatever happens to the urgency of a row", () => {
    const before = [approve("a", 1), approve("b", 2), approve("c", 3)]
    const open = openRow(settle(initialView, before), "c", before)
    // "a" stops waiting on the person, which moves it down in the Inbox's own order.
    const now = [{ ...before[0]!, stopped: false }, before[1]!, before[2]!]

    expect(ids(visible(open, now))).toEqual(["a", "b", "c"])
    expect(ids(visible({ ...open, open: null }, now))).toEqual(["b", "c", "a"])
  })

  it("keeps the place of a row that was answered and is gone", () => {
    const before = [approve("a", 1), approve("b", 2)]
    const open = openRow(settle(initialView, before), "a", before)

    expect(ids(visible(open, [before[1]!], { a: before[0]! }))).toEqual(["a", "b"])
  })
})

describe("The list", () => {
  it("orders trouble first, then the longest waiting, updates last", () => {
    const rows = [update("u", 1), approve("late", 9), approve("early", 2)]

    expect(ids(visible(initialView, rows))).toEqual(["early", "late", "u"])
  })
})

describe("What asks next", () => {
  const rows = [approve("a", 1), approve("b", 2), update("u", 0), approve("c", 3, false)]

  it("is the most urgent row other than the one answered", () => {
    expect(nextRow(rows, "a", { answering: {} })?.id).toBe("b")
    expect(nextRow(rows, "b", { answering: {} })?.id).toBe("a")
  })

  it("skips rows whose answer is on its way, and updates", () => {
    expect(nextRow(rows, "a", { answering: { b: true } })?.id).toBe("c")
    expect(nextRow([update("u", 0)], null, { answering: {} })).toBeUndefined()
  })
})

describe("Stepping down and up the list", () => {
  const rows = [approve("a", 1), approve("b", 2), approve("c", 3)]

  it("moves a row at a time and stops at the ends", () => {
    expect(stepFrom(rows, "a", 1)?.id).toBe("b")
    expect(stepFrom(rows, "c", 1)?.id).toBe("c")
    expect(stepFrom(rows, "a", -1)?.id).toBe("a")
  })

  it("starts at the first when nothing is open", () => {
    expect(stepFrom(rows, null, 1)?.id).toBe("a")
    expect(stepFrom(rows, null, -1)?.id).toBe("a")
  })
})

describe("What the rail counts", () => {
  context("with updates among the rows", () => {
    it("leaves them out", () => {
      expect(ids(needing([approve("a", 1), update("u", 2)]))).toEqual(["a"])
    })
  })

  context("with failed turns among the rows", () => {
    const failed = (id: string, stopped: boolean): InboxRow => ({
      id,
      source,
      at: 1,
      stopped,
      seen: false,
      kind: "trouble",
      trouble: { type: "failed", error: "boom", stored: true },
    })

    it("counts the agent's current one, and leaves an older one out, as it only informs", () => {
      const rows = [failed("now", true), failed("old", false)]
      expect(ids(needing(rows))).toEqual(["now"])
    })

    it("has Mark all read something to read for an older one only", () => {
      expect(hasUpdates([failed("now", true)])).toBe(false)
      expect(hasUpdates([failed("old", false)])).toBe(true)
    })
  })

  context("when stepping to the next row", () => {
    it("skips a failed turn that only informs", () => {
      const informs: InboxRow = {
        id: "old",
        source,
        at: 1,
        stopped: false,
        seen: false,
        kind: "trouble",
        trouble: { type: "failed", error: "boom", stored: true },
      }
      expect(nextRow([informs, approve("a", 2)], null, { answering: {} })?.id).toBe("a")
      expect(nextRow([informs], null, { answering: {} })).toBeUndefined()
    })
  })
})

describe("The line above the updates", () => {
  it("goes on the row after the last that asks", () => {
    expect(updatesStart([true, true, false, false])).toBe(2)
  })

  it("goes nowhere when nothing asks, or nothing follows what asks", () => {
    expect(updatesStart([false, false])).toBe(-1)
    expect(updatesStart([true, true])).toBe(-1)
    expect(updatesStart([])).toBe(-1)
  })

  context("while a sheet holds the order and a row above has stopped asking", () => {
    it("still sits under the last row that asks", () => {
      expect(updatesStart([false, true, false])).toBe(2)
      expect(updatesStart([true, false, true, false])).toBe(3)
    })
  })
})

// An ask the agent wrote, open or settled `how` at `at`.
const ask = (
  id: string,
  at: number,
  settled?: { how: "dismissed" | "withdrawn" | "replied"; at: number },
): InboxRow => ({
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

describe("An ask that has settled", () => {
  const rows = [ask("a", 1), ask("b", 2, { how: "dismissed", at: 9 })]

  it("is not held as news while a sheet is open", () => {
    const open = openRow(settle(initialView, [rows[0]!]), "a", [rows[0]!])
    expect(ids(held(open, rows))).toEqual([])
  })

  it("asks nothing: the count, the bell and the rings leave it out", () => {
    expect(needs(rows[1]!)).toBe(false)
    expect(ids(needing(rows))).toEqual(["a"])
  })

  it("is never what asks next", () => {
    expect(nextRow(rows, null, { answering: {} })?.id).toBe("a")
    expect(nextRow([rows[1]!], null, { answering: {} })).toBeUndefined()
  })

  it("lists below the rest, the latest settled first", () => {
    const all = [ask("c", 3, { how: "withdrawn", at: 5 }), rows[1]!, update("u", 4), rows[0]!]

    expect(ids(visible(settle(initialView, all), all))).toEqual(["a", "u", "b", "c"])
  })

  it("keeps its place while the panel is on screen, and drops below when it is shown again", () => {
    const open = [ask("a", 1), ask("b", 2), update("u", 3)]
    let view = settle(initialView, open, true)
    const after = [open[0]!, ask("b", 2, { how: "dismissed", at: 9 }), open[2]!]
    view = settle(view, after, true)

    expect(ids(visible(view, after))).toEqual(["a", "b", "u"])
    expect(ids(visible(settle(view, after, false), after))).toEqual(["a", "u", "b"])
  })

  it("does not move when a sheet closes with the panel still on screen", () => {
    const open = [ask("a", 1), ask("b", 2), update("u", 3)]
    let view = settle(initialView, open, true)
    view = openRow(view, "a", open)
    const after = [open[0]!, ask("b", 2, { how: "dismissed", at: 9 }), open[2]!]
    view = settle(view, after, true)

    expect(ids(visible(closeSheet(view, after), after))).toEqual(["a", "b", "u"])
  })
})

describe("The line above the settled asks", () => {
  it("goes on the first of the settled rows that end the list", () => {
    expect(settledStart([false, false, true, true])).toBe(2)
  })

  it("goes nowhere without settled rows at the end, or with nothing above them", () => {
    expect(settledStart([false, false])).toBe(-1)
    expect(settledStart([true, true])).toBe(-1)
    expect(settledStart([false, true, false])).toBe(-1)
    expect(settledStart([])).toBe(-1)
  })
})

describe("The rows that ask, in the person's order", () => {
  const items = [approve("a", 1), approve("b", 2), approve("c", 3), update("u", 0)]

  it("keep the Inbox's own order until the person drags them", () => {
    expect(ids(visible(initialView, items, {}, []))).toEqual(["a", "b", "c", "u"])
  })

  it("follow it, the updates still below them", () => {
    expect(ids(visible(initialView, items, {}, keyed("c", "a", "b")))).toEqual(["c", "a", "b", "u"])
  })

  it("keep an ask put off below one that comes after, as urgent", () => {
    const later = [...items, approve("d", 9)]

    expect(ids(visible(initialView, later, {}, keyed("b", "c", "a")))).toEqual([
      "d",
      "b",
      "c",
      "a",
      "u",
    ])
  })

  it("let one that comes after go below the placed rows more urgent than it", () => {
    // "w" waits while its agent works on: less urgent than any that stopped it.
    const later = [...items, approve("w", 0, false)]

    expect(ids(arrange(visible(initialView, later), keyed("c", "a", "b")))).toEqual([
      "c",
      "a",
      "b",
      "w",
      "u",
    ])
  })

  it("take a row asked again under the same id as new, not where the old one was put", () => {
    // "a" was put last and answered; the harness asks the same again, a row under its id.
    const again = [approve("a", 7), approve("b", 2), approve("c", 3)]
    expect(ids(visible(initialView, again, {}, keyed("b", "c", "a")))).toEqual(["a", "b", "c"])
  })

  it("forget the rows that have gone", () => {
    expect(ids(visible(initialView, items, {}, keyed("gone", "b", "a")))).toEqual([
      "c",
      "b",
      "a",
      "u",
    ])
  })

  it("set what asks next", () => {
    expect(nextRow(items, "c", { answering: {} }, keyed("c", "b", "a"))?.id).toBe("b")
  })

  it("leave a settled ask below them, and one that settled in place where it was", () => {
    const open = [ask("a", 1), ask("b", 2), ask("c", 3)]
    const view = settle(initialView, open, true)
    const after = [open[0]!, ask("b", 2, { how: "dismissed", at: 9 }), open[2]!]

    expect(ids(visible(settle(view, after, true), after, {}, keyed("c", "b", "a")))).toEqual([
      "c",
      "b",
      "a",
    ])
    expect(ids(visible(settle(view, after, false), after, {}, keyed("c", "b", "a")))).toEqual([
      "c",
      "a",
      "b",
    ])
  })

  it("move in the list an open sheet holds still, in the places they had", () => {
    const open = openRow(settle(initialView, items), "a", items)
    const moved = rearranged(open, ["c", "b", "a"])

    expect(ids(visible(moved, items))).toEqual(["c", "b", "a", "u"])
    // With no sheet open the list follows the order itself.
    const closed = { ...open, open: null }
    expect(rearranged(closed, ["c", "b", "a"])).toBe(closed)
  })
})

describe("A snoozed row", () => {
  const snoozed = (row: InboxRow): InboxRow => ({ ...row, snoozed: true })
  const items = [approve("a", 1), snoozed(approve("b", 2)), approve("c", 3), update("u", 0)]

  it("asks nothing now: the count, the bell and the rings leave it out", () => {
    expect(needs(items[1]!)).toBe(false)
    expect(ids(needing(items))).toEqual(["a", "c"])
  })

  it("is never what asks next", () => {
    expect(nextRow(items, "a", { answering: {} })?.id).toBe("c")
    expect(nextRow([items[1]!], null, { answering: {} })).toBeUndefined()
  })

  it("keeps its place, and the person's order moves it like any row that asks", () => {
    expect(ids(visible(initialView, items))).toEqual(["a", "b", "c", "u"])
    expect(ids(visible(initialView, items, {}, keyed("b", "c", "a")))).toEqual(["b", "c", "a", "u"])
  })
})

describe("The order after a drag", () => {
  it("keeps the place of a row the list didn't show, after the rows it followed", () => {
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
