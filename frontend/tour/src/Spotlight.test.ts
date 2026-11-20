import { coachPlace } from "./Spotlight"
import { describe, expect, it } from "./test"

const card = { width: 340, height: 190 }
const view = { width: 1440, height: 900 }

describe("Where the tour's coach stands", () => {
  it("beside a small anchor, below it", () => {
    expect(coachPlace({ left: 300, top: 40, width: 200, height: 32 }, card, view)).toEqual({
      left: 300,
      top: 84,
    })
  })

  it("above a small anchor with no room below", () => {
    expect(coachPlace({ left: 300, top: 820, width: 200, height: 40 }, card, view)).toEqual({
      left: 300,
      top: 618,
    })
  })

  it("inside the bottom right of a large one, clear of the top a fresh terminal draws from", () => {
    const terminal = { left: 440, top: 100, width: 980, height: 780 }
    const place = coachPlace(terminal, card, view)
    expect(place.left + card.width).toBeLessThanOrEqual(terminal.left + terminal.width)
    expect(place.top + card.height).toBeLessThanOrEqual(terminal.top + terminal.height)
    expect(place.top).toBeGreaterThan(terminal.top + terminal.height / 2)
  })

  it("in the window's corner where it points at nothing drawn", () => {
    expect(coachPlace(null, card, view)).toEqual({ left: 1084, top: 694 })
  })

  it("always within the window, however narrow", () => {
    const narrow = { width: 360, height: 640 }
    const place = coachPlace({ left: 300, top: 600, width: 50, height: 30 }, card, narrow)
    expect(place.left).toBeGreaterThanOrEqual(16)
    expect(place.top + card.height).toBeLessThanOrEqual(narrow.height - 16)
  })
})
