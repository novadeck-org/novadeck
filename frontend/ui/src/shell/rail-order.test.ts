import { describe, expect, it } from "../test"
import { movedPanel, railOrder } from "./rail-order"

describe("the rail's order", () => {
  it("is the rail's own until the person moves a panel", () => {
    expect(railOrder([])).toEqual([
      "terminals",
      "source",
      "sessions",
      "history",
      "inbox",
      "changes",
    ])
  })

  it("keeps the panels the person placed, then any never placed, in the rail's order", () => {
    expect(railOrder(["inbox", "terminals"])).toEqual([
      "inbox",
      "terminals",
      "source",
      "sessions",
      "history",
      "changes",
    ])
  })

  it("drops what isn't a panel, or is one twice", () => {
    expect(railOrder(["inbox", "gone", "inbox", "sessions"])).toEqual([
      "inbox",
      "sessions",
      "terminals",
      "source",
      "history",
      "changes",
    ])
  })

  it("puts History and Changes after the panels a person saved before they existed", () => {
    expect(railOrder(["inbox", "sessions", "source", "terminals"])).toEqual([
      "inbox",
      "sessions",
      "source",
      "terminals",
      "history",
      "changes",
    ])
  })

  it("moves a panel among those shown", () => {
    const order = railOrder([])
    expect(movedPanel(order, order, 4, 0)).toEqual([
      "inbox",
      "terminals",
      "source",
      "sessions",
      "history",
      "changes",
    ])
    expect(movedPanel(order, order, 0, 2)).toEqual([
      "source",
      "sessions",
      "terminals",
      "history",
      "inbox",
      "changes",
    ])
  })

  it("leaves a panel the backend doesn't show where it was", () => {
    const order = railOrder([])
    const shown = order.filter(
      (panel) => panel !== "source" && panel !== "history" && panel !== "changes",
    )
    expect(movedPanel(order, shown, 2, 0)).toEqual([
      "inbox",
      "source",
      "terminals",
      "history",
      "sessions",
      "changes",
    ])
  })
})
