import { context, describe, expect, it } from "../test"
import {
  arrangeCanvas,
  canvasPlaces,
  growCanvas,
  type Arranged,
  type CanvasArrangement,
} from "./canvas-arrangement"

// A canvas wide enough that the islands go beside a block one window wide.
const room = { width: 1280, height: 860 }
// A window is 864 by 576, 60 from the next: 924 across, 636 down. A team starts 144 right
// of its lead, and an island 240 from the block or the island before it.
const solo = (id: string): Arranged => ({ id })
const led = (id: string, lead: string): Arranged => ({ id, lead })

const at = (arrangement: CanvasArrangement, id: string): { x: number; y: number } | undefined =>
  canvasPlaces(arrangement).get(id)

const places = (arrangement: CanvasArrangement, ids: readonly string[]): string =>
  ids.map((id) => `${id} ${at(arrangement, id)?.x},${at(arrangement, id)?.y}`).join(" | ")

describe("the canvas's arrangement", () => {
  context("arranged afresh", () => {
    it("puts the windows on no team in one block, in the order given", () => {
      const arrangement = arrangeCanvas(["a", "b", "c", "d"].map(solo), room)
      expect(arrangement.columns).toBe(2)
      expect(places(arrangement, ["a", "b", "c", "d"])).toBe(
        "a 0,0 | b 924,0 | c 0,636 | d 924,636",
      )
    })

    it("makes each team an island beside the block: its lead, then its team to the right", () => {
      const arrangement = arrangeCanvas(
        [solo("a"), solo("lead"), led("one", "lead"), led("two", "lead"), solo("b")],
        room,
      )
      expect(arrangement.block).toEqual(["a", "b"])
      expect(arrangement.islands).toEqual(["lead"])
      expect(places(arrangement, ["a", "b", "lead", "one", "two"])).toBe(
        "a 0,0 | b 0,636 | lead 1104,0 | one 2112,0 | two 2112,636",
      )
    })

    it("stacks a team three deep, then takes another column", () => {
      const team = ["1", "2", "3", "4"].map((id) => led(id, "lead"))
      const arrangement = arrangeCanvas([solo("lead"), ...team], room)
      expect(places(arrangement, ["lead", "1", "2", "3", "4"])).toBe(
        "lead 0,0 | 1 1008,0 | 2 1008,636 | 3 1008,1272 | 4 1932,0",
      )
    })

    it("puts a teammate that leads below the others, its own team one step further right", () => {
      const arrangement = arrangeCanvas(
        [solo("lead"), led("sub", "lead"), led("deep", "sub"), led("plain", "lead")],
        room,
      )
      expect(places(arrangement, ["lead", "plain", "sub", "deep"])).toBe(
        "lead 0,0 | plain 1008,0 | sub 1008,636 | deep 2016,636",
      )
    })

    it("orders the islands by their leads", () => {
      const arrangement = arrangeCanvas(
        [solo("second"), led("y", "second"), solo("first"), led("x", "first")],
        room,
      )
      expect(arrangement.islands).toEqual(["second", "first"])
    })

    it("puts the islands below the block where that shows everything larger", () => {
      const tall = { width: 700, height: 1400 }
      const arrangement = arrangeCanvas([solo("a"), solo("lead"), led("one", "lead")], tall)
      expect(arrangement.beside).toBe(false)
      expect(places(arrangement, ["a", "lead", "one"])).toBe("a 0,0 | lead 0,816 | one 1008,816")
    })

    it("takes a lead that isn't on the canvas for no lead at all", () => {
      const arrangement = arrangeCanvas([solo("a"), led("b", "hidden")], room)
      expect(arrangement.block).toEqual(["a", "b"])
    })

    it("cuts a loop of leads at its first window, which leads the rest", () => {
      const arrangement = arrangeCanvas([led("a", "b"), led("b", "a")], room)
      expect(arrangement.islands).toEqual(["a"])
      expect(arrangement.teams).toEqual({ a: ["b"] })
    })
  })

  context("as it grows", () => {
    const before = arrangeCanvas(
      [solo("a"), solo("b"), solo("lead"), led("one", "lead"), solo("c")],
      room,
    )

    it("comes back the same when nothing has to move", () => {
      expect(
        growCanvas(before, [solo("c"), solo("b"), solo("lead"), led("one", "lead"), solo("a")]),
      ).toBe(before)
    })

    it("puts a window new to the canvas last in the block", () => {
      const grown = growCanvas(before, [
        solo("a"),
        solo("new"),
        solo("b"),
        solo("lead"),
        led("one", "lead"),
        solo("c"),
      ])
      expect(grown.block).toEqual(["a", "b", "c", "new"])
      expect(places(grown, ["a", "b", "c"])).toBe(places(before, ["a", "b", "c"]))
    })

    it("moves a window that starts to lead to an island after the others, its slot left empty", () => {
      const grown = growCanvas(before, [
        solo("a"),
        solo("b"),
        led("worker", "b"),
        solo("lead"),
        led("one", "lead"),
        solo("c"),
      ])
      expect(grown.block).toEqual(["a", null, "c"])
      expect(grown.islands).toEqual(["lead", "b"])
      expect(places(grown, ["a", "c", "lead", "one"])).toBe(
        places(before, ["a", "c", "lead", "one"]),
      )
      // The block is three across here, the islands below it, one under the other.
      expect(places(grown, ["lead", "b", "worker"])).toBe(
        "lead 0,816 | b 0,1632 | worker 1008,1632",
      )
    })

    it("moves a window that gets a lead into that lead's team, with the lead", () => {
      const grown = growCanvas(before, [
        solo("a"),
        led("c", "a"),
        solo("b"),
        solo("lead"),
        led("one", "lead"),
      ])
      expect(grown.block).toEqual([null, "b", null])
      expect(grown.islands).toEqual(["lead", "a"])
      expect(grown.teams).toEqual({ lead: ["one"], a: ["c"] })
    })

    it("pushes the islands after a team that grows", () => {
      const two = arrangeCanvas(
        [solo("first"), led("one", "first"), solo("second"), led("x", "second")],
        room,
      )
      const grown = growCanvas(two, [
        solo("first"),
        led("one", "first"),
        led("sub", "one"),
        solo("second"),
        led("x", "second"),
      ])
      expect(at(two, "second")).toEqual({ x: 0, y: 816 })
      expect(at(grown, "sub")).toEqual({ x: 2016, y: 0 })
      expect(at(grown, "second")).toEqual({ x: 0, y: 816 })
      const more = growCanvas(grown, [
        solo("first"),
        led("one", "first"),
        led("sub", "one"),
        led("two", "first"),
        solo("second"),
        led("x", "second"),
      ])
      expect(places(more, ["two", "one", "sub"])).toBe("two 1008,0 | one 1008,636 | sub 2016,636")
      expect(at(more, "second")).toEqual({ x: 0, y: 1452 })
    })

    it("moves a teammate to its new lead's team, leaving its place empty", () => {
      const grown = growCanvas(before, [
        solo("a"),
        solo("b"),
        solo("lead"),
        solo("c"),
        led("one", "c"),
      ])
      expect(grown.teams).toEqual({ lead: [null], c: ["one"] })
      expect(grown.islands).toEqual(["lead", "c"])
    })

    it("settles in one go when a lead comes to be led from inside its own team", () => {
      // a leads b, which leads c. Then a lets b go, and takes c for its lead.
      const chain = arrangeCanvas([led("c", "b"), solo("a"), led("b", "a")], room)
      const released = growCanvas(chain, [led("c", "b"), solo("a"), solo("b")])
      expect(released).toBe(chain)
      const turned = [led("c", "b"), led("a", "c"), solo("b")]
      const grown = growCanvas(released, turned)
      expect(growCanvas(grown, turned)).toBe(grown)
      expect(grown.islands).toEqual(["b"])
    })

    it("starts an island for a lead that sat in the team of the window it now leads", () => {
      const grown = growCanvas(before, [solo("a"), solo("b"), led("lead", "one"), solo("one")])
      expect(grown.islands).toEqual(["one"])
      expect(grown.teams).toEqual({ lead: [null], one: ["lead"] })
    })
  })

  context("as a team grows past a column", () => {
    it("moves none of the teammates placed before", () => {
      const team = ["1", "2", "3"].map((id) => led(id, "lead"))
      const before = arrangeCanvas([solo("lead"), ...team], room)
      const after = growCanvas(before, [solo("lead"), ...team, led("4", "lead")])
      for (const id of ["lead", "1", "2", "3"]) expect(at(after, id)).toEqual(at(before, id))
      expect(at(after, "4")).toEqual({ x: 1932, y: 0 })
    })
  })

  context("as it shrinks", () => {
    const before = arrangeCanvas(
      [solo("a"), solo("b"), solo("lead"), led("one", "lead"), led("two", "lead"), solo("c")],
      room,
    )
    const all = ["a", "b", "c", "lead", "one", "two"]

    it("keeps the place of a window that is gone, empty", () => {
      const shrunk = growCanvas(before, [solo("a"), solo("lead"), led("two", "lead"), solo("c")])
      expect(shrunk).toBe(before)
      expect(places(shrunk, all)).toBe(places(before, all))
    })

    it("leaves a lead whose team has gone where it is", () => {
      const shrunk = growCanvas(before, [solo("a"), solo("b"), solo("lead"), solo("c")])
      expect(shrunk.islands).toEqual(["lead"])
      expect(at(shrunk, "lead")).toEqual(at(before, "lead"))
    })

    it("leaves a team where it is when its lead leads no more, or is gone", () => {
      const ended = [solo("a"), solo("b"), solo("lead"), solo("one"), solo("two"), solo("c")]
      expect(growCanvas(before, ended)).toBe(before)
      expect(
        growCanvas(
          before,
          ended.filter((tile) => tile.id !== "lead"),
        ),
      ).toBe(before)
    })

    it("gives a window that comes back the place it had", () => {
      const gone = growCanvas(before, [solo("a"), solo("lead"), led("one", "lead"), solo("c")])
      const back = growCanvas(gone, [
        solo("a"),
        solo("b"),
        solo("lead"),
        led("one", "lead"),
        led("two", "lead"),
        solo("c"),
      ])
      expect(places(back, all)).toBe(places(before, all))
    })

    it("puts a window opened afterwards last, not in the empty slot", () => {
      const grown = growCanvas(before, [
        solo("a"),
        solo("lead"),
        led("one", "lead"),
        led("two", "lead"),
        solo("c"),
        solo("new"),
      ])
      expect(grown.block).toEqual(["a", "b", "c", "new"])
    })
  })
})
