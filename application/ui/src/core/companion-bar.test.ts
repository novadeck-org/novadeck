import { context, describe, expect, it } from "../test"
import { itemIdOf } from "./companion"
import {
  arrive,
  arriveLast,
  closePane,
  emptyBar,
  hide,
  leave,
  messagesKey,
  moveSlot,
  openTab,
  reopen,
  settle,
  type Bar,
  type BarKey,
} from "./companion-bar"

const plan = itemIdOf("plan")
const hero = itemIdOf("hero")
const about = itemIdOf("about")
const notes = itemIdOf("notes")
const bar = (change: Partial<Bar> = {}): Bar => ({ ...emptyBar, ...change })

describe("a companion bar", () => {
  context("when something arrives", () => {
    it("joins the end, once", () => {
      expect(arrive(arrive(bar({ order: [plan] }), hero), hero).order).toEqual([plan, hero])
    })

    it("stays off the bar while the person hides it", () => {
      const hidden = bar({ hidden: [plan] })
      expect(arrive(hidden, plan)).toBe(hidden)
    })

    it("comes last when moved here, even from where it was", () => {
      const moved = arriveLast(bar({ order: [hero, plan], hidden: [about] }), hero)
      expect(moved.order).toEqual([plan, hero])
      expect(arriveLast(moved, about)).toMatchObject({ order: [plan, hero, about], hidden: [] })
    })
  })

  context("when the person hides what the pane shows", () => {
    it("closes the pane, so nothing takes its place", () => {
      const hidden = hide(bar({ order: [plan, hero], tab: plan, open: true }), plan)
      expect(hidden).toEqual({ order: [hero], hidden: [plan], tab: null, open: false })
    })

    it("comes back last when reopened", () => {
      expect(reopen(hide(bar({ order: [plan, hero] }), plan), plan).order).toEqual([hero, plan])
    })
  })

  context("when something leaves", () => {
    it("goes from the order and from what's hidden, closing a pane open to it", () => {
      expect(leave(bar({ order: [hero], tab: hero, open: true }), hero)).toEqual(emptyBar)
      expect(leave(bar({ hidden: [plan] }), plan).hidden).toEqual([])
    })

    it("leaves the bar as it was when it wasn't there", () => {
      const before = bar({ order: [hero] })
      expect(leave(before, about)).toBe(before)
    })
  })

  it("opens and closes its pane", () => {
    const opened = openTab(emptyBar, messagesKey)
    expect(opened).toMatchObject({ tab: messagesKey, open: true })
    expect(closePane(opened)).toMatchObject({ tab: messagesKey, open: false })
    expect(closePane(emptyBar)).toBe(emptyBar)
  })

  context("when an icon is moved", () => {
    it("moves a stack's keys together, keeping what's off the bar in place", () => {
      const before = bar({ order: [plan, hero, notes, about, messagesKey] })
      const slots: BarKey[][] = [[plan], [hero, about], [notes], [messagesKey]]
      expect(moveSlot(before, slots, 1, 3).order).toEqual([plan, notes, messagesKey, hero, about])
    })

    it("stays put for a move to where it is", () => {
      const before = bar({ order: [plan, hero] })
      expect(moveSlot(before, [[plan], [hero]], 1, 1)).toBe(before)
    })
  })

  context("when settled against what's known", () => {
    it("drops what's gone and closes a pane that showed it", () => {
      const settled = settle(
        bar({ order: [plan, hero], hidden: [about], tab: hero, open: true }),
        (key) => key === plan,
      )
      expect(settled).toEqual({ order: [plan], hidden: [], tab: null, open: false })
    })

    it("keeps a bar that knows all it holds", () => {
      const before = bar({ order: [plan], tab: plan, open: true })
      expect(settle(before, () => true)).toBe(before)
    })
  })
})
