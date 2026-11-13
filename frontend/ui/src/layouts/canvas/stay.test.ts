import { terminalFixture } from "@novadeck/core/testing"
import type { Tile } from "@novadeck/core/types"

import { context, describe, expect, it } from "../../test"
import {
  arrangedTiles,
  beginStay,
  continueStay,
  createCanvasStays,
  moveInStay,
  stayPlaces,
} from "./stay"

const room = { width: 1280, height: 860 }
const tiles = [{ id: "a" }, { id: "b" }, { id: "lead" }, { id: "one", lead: "lead" }]

describe("a stay on Canvas", () => {
  it("begins with every window in its arranged place", () => {
    const places = stayPlaces(beginStay(tiles, room))
    expect(places.get("a")).toEqual({ x: 0, y: 0 })
    expect(places.get("one")!.x).toBeGreaterThan(places.get("lead")!.x)
  })

  context("when the person drags a window", () => {
    const dragged = moveInStay(beginStay(tiles, room), "a", { x: 480, y: -240 })

    it("has the window where they left it, and the others where they were", () => {
      const places = stayPlaces(dragged)
      expect(places.get("a")).toEqual({ x: 480, y: -240 })
      expect(places.get("b")).toEqual(stayPlaces(beginStay(tiles, room)).get("b"))
    })

    it("keeps it there while the canvas's other windows change", () => {
      const next = continueStay(dragged, [...tiles, { id: "new" }])
      expect(stayPlaces(next).get("a")).toEqual({ x: 480, y: -240 })
    })

    it("lets the arrangement take it once that moves it, as when it starts to lead", () => {
      const next = continueStay(dragged, [...tiles, { id: "worker", lead: "a" }])
      expect(next.moved).toEqual({})
      expect(next.arrangement.islands).toEqual(["lead", "a"])
    })

    it("forgets it once the window is gone", () => {
      const next = continueStay(
        dragged,
        tiles.filter((tile) => tile.id !== "a"),
      )
      expect(next.moved).toEqual({})
    })

    it("is undone by a stay begun afresh", () => {
      expect(stayPlaces(beginStay(tiles, room)).get("a")).toEqual({ x: 0, y: 0 })
    })
  })

  it("comes back the same when nothing changed", () => {
    const stay = moveInStay(beginStay(tiles, room), "a", { x: 24, y: 24 })
    expect(continueStay(stay, tiles)).toBe(stay)
    expect(moveInStay(stay, "a", { x: 24, y: 24 })).toBe(stay)
  })

  it("is held for each session apart, for the sidebar's order it was arranged for", () => {
    const stays = createCanvasStays()
    const stay = beginStay(tiles, room)
    const camera = { x: 10, y: 20, zoom: 0.5 }
    stays.of("one").keep(stay, 2, camera)
    expect(stays.of("one").kept(2)).toEqual({ stay, camera })
    expect(stays.of("one").kept(3)).toBeUndefined()
    expect(stays.of("two").kept(2)).toBeUndefined()
  })
})

describe("the windows a canvas arranges", () => {
  const terminals: readonly Tile[] = [
    { ...terminalFixture(1, "~"), handle: "fox", state: "starting" },
    { ...terminalFixture(2, "~"), handle: "owl", ledBy: "01" },
    { ...terminalFixture(3, "~"), ledBy: "gone" },
    { ...terminalFixture(4, "~"), handle: "kit", ledBy: null, openedBy: "01" },
    { ...terminalFixture(5, "~"), openedBy: "01" },
  ]

  it("takes each window's lead from the terminal its backend named, running or not", () => {
    expect(arrangedTiles(terminals, () => false).slice(0, 4)).toEqual([
      { id: "01", lead: undefined },
      { id: "02", lead: "01" },
      { id: "03", lead: undefined },
      { id: "04", lead: undefined },
    ])
  })

  it("takes its opener for the lead of one its backend hasn't described yet", () => {
    expect(arrangedTiles(terminals, () => false)[4]).toEqual({ id: "05", lead: "01" })
  })

  it("leaves out the windows asked, in the order given", () => {
    expect(arrangedTiles(terminals, (tile) => tile.id === "02").map((tile) => tile.id)).toEqual([
      "01",
      "03",
      "04",
      "05",
    ])
  })
})
