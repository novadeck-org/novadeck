import { placeBox, type Box } from "./place"
import { context, describe, expect, it } from "./test"

const card = { width: 300, height: 60 }
const area: Box = { left: 0, top: 50, width: 1280, height: 700 }
const lead: Box = { left: 80, top: 120, width: 430, height: 290 }
const fox: Box = { left: 590, top: 120, width: 430, height: 290 }
const owl: Box = { left: 590, top: 440, width: 430, height: 290 }

const overlaps = (place: { left: number; top: number }, box: Box): boolean =>
  place.left < box.left + box.width &&
  box.left < place.left + card.width &&
  place.top < box.top + box.height &&
  box.top < place.top + card.height

describe("Where the tour's caption box stands", () => {
  context("in Canvas, with space beside its subject", () => {
    it("goes below it, aligned to its start", () => {
      expect(placeBox(lead, card, area, [lead, fox, owl])).toEqual({ left: 80, top: 428 })
    })

    it("goes beside it where below is taken", () => {
      const tall = { ...lead, height: 640 }
      const place = placeBox(tall, card, area, [tall])
      expect(place).toEqual({ left: 528, top: 120 })
    })

    it("never over a window", () => {
      const place = placeBox(fox, card, area, [lead, fox, owl])
      for (const window of [lead, fox, owl]) expect(overlaps(place, window)).toBe(false)
    })
  })

  context("with no space beside its subject", () => {
    // Grid with three windows: the bottom right cell is empty.
    const cells: Box[] = [
      { left: 0, top: 50, width: 640, height: 350 },
      { left: 640, top: 50, width: 640, height: 350 },
      { left: 0, top: 400, width: 640, height: 350 },
    ]

    it("takes the lowest free spot, as a Grid's empty cell", () => {
      const place = placeBox(cells[0]!, card, area, cells)
      expect(place.left).toBeGreaterThanOrEqual(640)
      expect(place.top).toBeGreaterThanOrEqual(400)
      for (const window of cells) expect(overlaps(place, window)).toBe(false)
    })

    it("docks low in the corner where no spot is free", () => {
      const full: Box[] = [...cells, { left: 640, top: 400, width: 640, height: 350 }]
      expect(placeBox(full[0]!, card, area, full)).toEqual({ left: 16, top: 674 })
    })
  })

  it("always within the workspace, however small", () => {
    const small: Box = { left: 0, top: 50, width: 360, height: 300 }
    const place = placeBox({ left: 300, top: 300, width: 40, height: 30 }, card, small, [])
    expect(place.left).toBeGreaterThanOrEqual(16)
    expect(place.left + card.width).toBeLessThanOrEqual(small.width)
    expect(place.top + card.height).toBeLessThanOrEqual(small.top + small.height)
  })
})
