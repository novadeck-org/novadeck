import type { InboxItem } from "../model/inbox"
import { context, describe, expect, it } from "../test"
import {
  clearArrived,
  closeSheet,
  held,
  initialView,
  needing,
  nextItem,
  openItem,
  release,
  settle,
  stepFrom,
  visible,
} from "./inbox-state"

const source: InboxItem["source"] = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "t",
  handle: "moth",
  agent: "claude",
  title: "Title",
  projectName: "Project",
}

// A permission that waited since `at`.
const approve = (id: string, at: number, stopped = true): InboxItem => ({
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
const update = (id: string, at: number): InboxItem => ({
  id,
  source,
  at,
  stopped: false,
  seen: false,
  kind: "update",
  update: { type: "told", subject: id, body: "" },
})

const ids = (items: readonly InboxItem[]): string[] => items.map(({ id }) => id)

describe("What the Inbox starts with", () => {
  it("is on the list at once, and none of it counts as having just arrived", () => {
    const items = [approve("a", 1), approve("b", 2)]
    const view = settle(initialView, items)

    expect(ids(visible(view, items))).toEqual(["a", "b"])
    expect(view.arrived).toEqual([])
  })
})

describe("An item that arrives with no sheet open", () => {
  it("joins the list and is marked as arrived until the mark is cleared", () => {
    const before = [approve("a", 1)]
    const now = [...before, approve("b", 2)]
    const view = settle(settle(initialView, before), now)

    expect(ids(visible(view, now))).toEqual(["a", "b"])
    expect(view.arrived).toEqual(["b"])
    expect(clearArrived(view).arrived).toEqual([])
  })

  it("leaves the view as it was when nothing changed", () => {
    const items = [approve("a", 1)]
    const view = settle(initialView, items)

    expect(settle(view, items)).toBe(view)
  })
})

describe("An item that arrives while a sheet is open", () => {
  const before = [approve("a", 1), approve("b", 2)]
  const arrival = approve("c", 3)
  const now = [...before, arrival]
  const open = openItem(settle(initialView, before), "a", before)

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

  it("keeps showing an item the person answered, until the backend drops it", () => {
    expect(ids(visible(open, [before[1]!, arrival]))).toEqual(["b"])
  })
})

describe("The list while a sheet is open", () => {
  it("keeps its order, whatever happens to the urgency of an item", () => {
    const before = [approve("a", 1), approve("b", 2), approve("c", 3)]
    const open = openItem(settle(initialView, before), "c", before)
    // "a" stops waiting on the person, which moves it down in the Inbox's own order.
    const now = [{ ...before[0]!, stopped: false }, before[1]!, before[2]!]

    expect(ids(visible(open, now))).toEqual(["a", "b", "c"])
    expect(ids(visible({ ...open, open: null }, now))).toEqual(["b", "c", "a"])
  })

  it("keeps the place of an item that was answered and is gone", () => {
    const before = [approve("a", 1), approve("b", 2)]
    const open = openItem(settle(initialView, before), "a", before)

    expect(ids(visible(open, [before[1]!], { a: before[0]! }))).toEqual(["a", "b"])
  })
})

describe("The list", () => {
  it("orders trouble first, then the longest waiting, updates last", () => {
    const items = [update("u", 1), approve("late", 9), approve("early", 2)]

    expect(ids(visible(initialView, items))).toEqual(["early", "late", "u"])
  })
})

describe("What asks next", () => {
  const items = [approve("a", 1), approve("b", 2), update("u", 0), approve("c", 3, false)]

  it("is the most urgent item other than the one answered", () => {
    expect(nextItem(items, "a", { answering: {} })?.id).toBe("b")
    expect(nextItem(items, "b", { answering: {} })?.id).toBe("a")
  })

  it("skips items whose answer is on its way, and updates", () => {
    expect(nextItem(items, "a", { answering: { b: true } })?.id).toBe("c")
    expect(nextItem([update("u", 0)], null, { answering: {} })).toBeUndefined()
  })
})

describe("Stepping down and up the list", () => {
  const items = [approve("a", 1), approve("b", 2), approve("c", 3)]

  it("moves a row at a time and stops at the ends", () => {
    expect(stepFrom(items, "a", 1)?.id).toBe("b")
    expect(stepFrom(items, "c", 1)?.id).toBe("c")
    expect(stepFrom(items, "a", -1)?.id).toBe("a")
  })

  it("starts at the first when nothing is open", () => {
    expect(stepFrom(items, null, 1)?.id).toBe("a")
    expect(stepFrom(items, null, -1)?.id).toBe("a")
  })
})

describe("What the rail counts", () => {
  context("with updates among the items", () => {
    it("leaves them out", () => {
      expect(ids(needing([approve("a", 1), update("u", 2)]))).toEqual(["a"])
    })
  })
})
