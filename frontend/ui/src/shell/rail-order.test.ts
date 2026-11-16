import { describe, expect, it } from "../test"
import { movedPanel, railOrder } from "./rail-order"

describe("the rail's order", () => {
  it("is the rail's own until the person moves a panel", () => {
    expect(railOrder([])).toEqual([
      "terminals",
      "inbox",
      "sessions",
      "worktrees",
      "files",
      "history",
    ])
  })

  it("keeps the panels the person placed, then any never placed, in the rail's order", () => {
    expect(railOrder(["inbox", "terminals"])).toEqual([
      "inbox",
      "terminals",
      "sessions",
      "worktrees",
      "files",
      "history",
    ])
  })

  it("drops what isn't a panel, or is one twice", () => {
    expect(railOrder(["inbox", "gone", "inbox", "sessions"])).toEqual([
      "inbox",
      "sessions",
      "terminals",
      "worktrees",
      "files",
      "history",
    ])
  })

  it("puts Worktrees and History after the panels a person saved before they existed", () => {
    expect(railOrder(["inbox", "sessions", "files", "terminals"])).toEqual([
      "inbox",
      "sessions",
      "files",
      "terminals",
      "worktrees",
      "history",
    ])
  })

  it("keeps an order saved under the rail's former default as it was", () => {
    const former = ["terminals", "files", "sessions", "history", "inbox", "worktrees"]
    expect(railOrder(former)).toEqual(former)
  })

  it("reads a panel stored under its former id in its place", () => {
    expect(railOrder(["inbox", "changes", "terminals", "source"])).toEqual([
      "inbox",
      "worktrees",
      "terminals",
      "files",
      "sessions",
      "history",
    ])
  })

  it("keeps a panel stored under both its ids once, where it first stands", () => {
    expect(railOrder(["source", "inbox", "files"])).toEqual([
      "files",
      "inbox",
      "terminals",
      "sessions",
      "worktrees",
      "history",
    ])
  })

  it("moves a panel among those shown", () => {
    const order = railOrder([])
    expect(movedPanel(order, order, 4, 0)).toEqual([
      "files",
      "terminals",
      "inbox",
      "sessions",
      "worktrees",
      "history",
    ])
    expect(movedPanel(order, order, 0, 2)).toEqual([
      "inbox",
      "sessions",
      "terminals",
      "worktrees",
      "files",
      "history",
    ])
  })

  it("leaves a panel the backend doesn't show where it was", () => {
    const order = railOrder([])
    const shown = order.filter(
      (panel) => panel !== "files" && panel !== "history" && panel !== "worktrees",
    )
    expect(movedPanel(order, shown, 2, 0)).toEqual([
      "sessions",
      "terminals",
      "inbox",
      "worktrees",
      "files",
      "history",
    ])
  })
})
