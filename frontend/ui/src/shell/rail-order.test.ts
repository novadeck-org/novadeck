import { describe, expect, it } from "../test"
import { movedPanel, railOrder } from "./rail-order"

describe("the rail's order", () => {
  it("is the rail's own until the person moves a panel", () => {
    expect(railOrder([])).toEqual([
      "terminals",
      "inbox",
      "sessions",
      "changes",
      "source",
      "history",
    ])
  })

  it("keeps the panels the person placed, then any never placed, in the rail's order", () => {
    expect(railOrder(["inbox", "terminals"])).toEqual([
      "inbox",
      "terminals",
      "sessions",
      "changes",
      "source",
      "history",
    ])
  })

  it("drops what isn't a panel, or is one twice", () => {
    expect(railOrder(["inbox", "gone", "inbox", "sessions"])).toEqual([
      "inbox",
      "sessions",
      "terminals",
      "changes",
      "source",
      "history",
    ])
  })

  it("puts Changes and History after the panels a person saved before they existed", () => {
    expect(railOrder(["inbox", "sessions", "source", "terminals"])).toEqual([
      "inbox",
      "sessions",
      "source",
      "terminals",
      "changes",
      "history",
    ])
  })

  it("moves a panel among those shown", () => {
    const order = railOrder([])
    expect(movedPanel(order, order, 4, 0)).toEqual([
      "source",
      "terminals",
      "inbox",
      "sessions",
      "changes",
      "history",
    ])
    expect(movedPanel(order, order, 0, 2)).toEqual([
      "inbox",
      "sessions",
      "terminals",
      "changes",
      "source",
      "history",
    ])
  })

  it("leaves a panel the backend doesn't show where it was", () => {
    const order = railOrder([])
    const shown = order.filter(
      (panel) => panel !== "source" && panel !== "history" && panel !== "changes",
    )
    expect(movedPanel(order, shown, 2, 0)).toEqual([
      "sessions",
      "terminals",
      "inbox",
      "changes",
      "source",
      "history",
    ])
  })
})
