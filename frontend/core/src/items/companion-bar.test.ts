import { itemIdOf } from "../items"
import { context, describe, expect, it } from "../test"
import {
  arrive,
  arriveLast,
  closePane,
  emptyBar,
  hide,
  leave,
  messagesKey,
  minimize,
  moveSlot,
  raise,
  reopen,
  settle,
  topOf,
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
    it("closes the pane once nothing's behind it", () => {
      const hidden = hide(bar({ order: [plan, hero], stack: [plan], open: true }), plan)
      expect(hidden).toEqual({ order: [hero], hidden: [plan], stack: [], open: false })
    })

    it("uncovers what's open behind it", () => {
      const hidden = hide(bar({ order: [plan, hero], stack: [hero, plan], open: true }), plan)
      expect(hidden).toMatchObject({ stack: [hero], open: true })
    })

    it("comes back last when reopened", () => {
      expect(reopen(hide(bar({ order: [plan, hero] }), plan), plan).order).toEqual([hero, plan])
    })
  })

  context("when something leaves", () => {
    it("goes from the order and from what's hidden, closing a pane open to it", () => {
      expect(leave(bar({ order: [hero], stack: [hero], open: true }), hero)).toEqual(emptyBar)
      expect(leave(bar({ hidden: [plan] }), plan).hidden).toEqual([])
    })

    it("leaves the bar as it was when it wasn't there", () => {
      const before = bar({ order: [hero] })
      expect(leave(before, about)).toBe(before)
    })

    it("leaves what's in front where it is when it was behind", () => {
      const left = leave(bar({ order: [plan, hero], stack: [hero, plan], open: true }), hero)
      expect(left).toMatchObject({ stack: [plan], open: true })
    })
  })

  context("when its pane opens to something", () => {
    it("comes out with it on top, from wherever it was", () => {
      const opened = raise(raise(emptyBar, plan), hero)
      expect(opened).toMatchObject({ stack: [plan, hero], open: true })
      expect(topOf(raise(opened, plan))).toBe(plan)
      expect(raise(opened, hero)).toBe(opened)
    })

    it("hides, keeping what's open for when it comes back", () => {
      const hidden = closePane(raise(raise(emptyBar, plan), hero))
      expect(hidden).toMatchObject({ stack: [plan, hero], open: false })
      expect(raise(hidden, hero)).toMatchObject({ stack: [plan, hero], open: true })
      expect(closePane(emptyBar)).toBe(emptyBar)
    })
  })

  context("when the person minimizes what the pane shows", () => {
    it("uncovers what's behind it, keeping it on the bar", () => {
      const opened = bar({ order: [plan, hero], stack: [plan, hero], open: true })
      expect(minimize(opened, hero)).toEqual({ ...opened, stack: [plan] })
    })

    it("hides the pane once nothing's behind it", () => {
      expect(minimize(raise(emptyBar, hero), hero)).toEqual({ ...emptyBar, open: false })
    })

    it("hides the pane when what it showed wasn't in its stack", () => {
      const opened = bar({ stack: [plan], open: true })
      expect(minimize(opened, hero)).toEqual({ ...opened, open: false })
    })
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
    it("drops what's gone, uncovering what was behind it", () => {
      const settled = settle(
        bar({ order: [plan, hero], hidden: [about], stack: [plan, hero], open: true }),
        (key) => key === plan,
      )
      expect(settled).toEqual({ order: [plan], hidden: [], stack: [plan], open: true })
    })

    it("closes a pane left with nothing open", () => {
      const settled = settle(bar({ order: [hero], stack: [hero], open: true }), () => false)
      expect(settled).toEqual(emptyBar)
    })

    it("keeps a bar that knows all it holds", () => {
      const before = bar({ order: [plan], stack: [plan], open: true })
      expect(settle(before, () => true)).toBe(before)
    })
  })
})
