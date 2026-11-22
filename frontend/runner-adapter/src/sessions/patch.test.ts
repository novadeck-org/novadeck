import { context, describe, expect, it } from "../test"
import { applyPatch, diffPatch, emptyPatch, rebased } from "./patch"

// A saved state as state.ts writes it, by its parts.
const saved = (state: {
  order?: string[]
  geometry?: Record<string, object>
  hidden?: Record<string, boolean>
  spans?: Record<string, object>
  bars?: Record<string, object>
  view?: string
}) => ({
  version: 2,
  state: {
    order: state.order ?? ["a", "b"],
    layout: {
      canvas: { geometry: state.geometry ?? {} },
      hidden: state.hidden ?? {},
      spans: state.spans ?? {},
      grid: {},
    },
    view: state.view ?? "grid",
    windowedView: "grid",
    selected: "a",
    bars: state.bars ?? {},
  },
})

const at = { x: 0, y: 0, width: 400, height: 300 }

describe("session patches", () => {
  context("as a client makes them", () => {
    it("changes a terminal's geometry as one record, never a field of it", () => {
      const from = saved({ geometry: { a: at } })
      const to = saved({ geometry: { a: { ...at, x: 40 } } })
      expect(diffPatch(from, to)).toEqual({
        set: [{ path: ["state", "layout", "canvas", "geometry", "a"], value: { ...at, x: 40 } }],
        unset: [],
      })
    })

    it("takes a record out that's gone, and keeps the order whole", () => {
      const from = saved({ order: ["a", "b"], bars: { b: { open: true } } })
      const to = saved({ order: ["b", "a"] })
      expect(diffPatch(from, to)).toEqual({
        set: [{ path: ["state", "order"], value: ["b", "a"] }],
        unset: [["state", "bars", "b"]],
      })
    })

    it("sends a record map whole where the runner has none, an empty one too", () => {
      const to = saved({ geometry: { a: at } })
      const patch = diffPatch({}, to)
      expect(patch.set.map(({ path }) => path.join("."))).toEqual([
        "state.layout.canvas.geometry",
        "state.layout.hidden",
        "state.layout.spans",
        "state.bars",
        "version",
        "state.order",
        "state.layout.grid",
        "state.view",
        "state.windowedView",
        "state.selected",
      ])
      expect(applyPatch({}, patch)).toEqual(to)
    })

    it("is empty between a state and itself", () => {
      expect(emptyPatch(diffPatch(saved({}), saved({})))).toBe(true)
    })

    it("gives the runner's state the client's when applied to it", () => {
      const from = saved({ geometry: { a: at }, hidden: { b: true } })
      const to = saved({ geometry: { b: at }, view: "canvas" })
      expect(applyPatch(from, diffPatch(from, to))).toEqual(to)
    })
  })

  context("when two clients change one session", () => {
    // A sends its change made on revision 5; B's lands first, as 6; A's lands as 7. A slow
    // reader may read only 7, written by A, which holds B's change too.
    it("keeps the other's change a client's own later one folded in", () => {
      const five = saved({ geometry: { a: at, b: at } })
      const fromA = saved({ geometry: { a: { ...at, x: 10 }, b: at } })
      const six = saved({ geometry: { a: at, b: { ...at, y: 20 } } })
      const seven = applyPatch(six, diffPatch(five, fromA))
      // A holds its own change, and last knew 5 as the runner's.
      const held = rebased(JSON.stringify(five), JSON.stringify(fromA), JSON.stringify(seven))
      expect(JSON.parse(held!)).toEqual(
        saved({ geometry: { a: { ...at, x: 10 }, b: { ...at, y: 20 } } }),
      )
    })

    it("keeps its own change not yet sent over the other's", () => {
      const five = saved({ geometry: { a: at, b: at } })
      const mine = saved({ geometry: { a: { ...at, x: 10 }, b: at } })
      const theirs = saved({ geometry: { a: at, b: { ...at, y: 20 } } })
      const held = rebased(JSON.stringify(five), JSON.stringify(mine), JSON.stringify(theirs))
      expect(JSON.parse(held!)).toEqual(
        saved({ geometry: { a: { ...at, x: 10 }, b: { ...at, y: 20 } } }),
      )
    })

    it("changes nothing for its own change coming back", () => {
      const five = saved({ geometry: { a: at } })
      const mine = saved({ geometry: { a: { ...at, x: 10 } } })
      const echo = applyPatch(five, diffPatch(five, mine))
      const held = rebased(JSON.stringify(echo), JSON.stringify(mine), JSON.stringify(echo))
      expect(JSON.parse(held!)).toEqual(mine)
    })

    it("keeps the later of two changes to one record whole", () => {
      const five = saved({ geometry: { a: at } })
      const mine = saved({ geometry: { a: { ...at, x: 10 } } })
      const theirs = saved({ geometry: { a: { ...at, y: 20, width: 500 } } })
      const held = rebased(JSON.stringify(five), JSON.stringify(mine), JSON.stringify(theirs))
      // Mine is the later here, as it isn't sent yet: whole, none of theirs mixed in.
      expect(JSON.parse(held!)).toEqual(mine)
    })

    it("can't read a state that isn't JSON", () => {
      expect(rebased(null, JSON.stringify(saved({})), "nope")).toBeUndefined()
    })
  })
})
