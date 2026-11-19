import { describe, expect, it } from "vitest"

import {
  between,
  easeOf,
  framingOf,
  liftAbout,
  liftAtRail,
  phoneAt,
  phoneBezel,
  phoneMargin,
  phoneTravel,
  phoneZoomOf,
  railEnd,
  railOf,
  zoomGain,
} from "./framing.js"
import { phoneScreen } from "./phone.js"

const room = 2 * (phoneBezel + phoneMargin)

describe("a phone's zoom level", () => {
  it("is as wide as the viewer less a margin a side, where that shows at most 60% of its height", () => {
    // 900 high: 60% of the phone is in view at 1.39, the width allows 1.2.
    const level = phoneZoomOf(520, 900)!
    expect(level).toBeCloseTo((520 - room) / phoneScreen.width, 6)
    // Its frame, as wide as the viewer less a margin a side.
    expect(phoneScreen.width * level + 2 * phoneBezel).toBeCloseTo(520 - 2 * phoneMargin, 6)
  })

  it("stops early in a short, wide viewer, where 60% of the phone's height is in view", () => {
    const level = phoneZoomOf(1200, 500)!
    expect(level).toBeCloseTo((500 / 0.6 - 2 * phoneBezel) / phoneScreen.height, 6)
    // Its frame, taller than the viewer: 60% of it shows.
    expect((phoneScreen.height * level + 2 * phoneBezel) * 0.6).toBeCloseTo(500, 6)
  })

  it("is none where it gains under a tenth over fit, as in a viewer as narrow as the phone is", () => {
    // Fit is as wide as the viewer allows, and so is the zoom.
    expect(phoneZoomOf(300, 2000)).toBeUndefined()
    const fit = framingOf("phone", 400, 2000)!
    expect(phoneZoomOf(400, 2000)).toBeUndefined()
    expect(fit.scale).toBeCloseTo((400 - room) / phoneScreen.width, 6)
    // Wider than the phone's own size, fit stops at it and zoom doesn't.
    expect(framingOf("phone", 520, 2000)!.scale).toBe(1)
    expect(phoneZoomOf(520, 2000)!).toBeCloseTo(1.2, 6)
    // Nothing to frame, nothing to zoom.
    expect(phoneZoomOf(0, 0)).toBeUndefined()
  })

  it("gains at least a tenth over fit where there is one", () => {
    for (const [width, height] of [
      [520, 900],
      [1200, 500],
      [800, 700],
    ] as const)
      expect(phoneZoomOf(width, height)!).toBeGreaterThanOrEqual(
        zoomGain * framingOf("phone", width, height)!.scale,
      )
  })

  it("is never more than a page zooms", () => {
    expect(phoneZoomOf(4000, 6000)).toBe(5)
  })
})

describe("a phone drawn at a scale", () => {
  it("is centred across and, where it fits, up and down", () => {
    const at = phoneAt(600, 1200, 1, 0.7)
    expect(at).toEqual({
      width: phoneScreen.width,
      height: phoneScreen.height,
      scale: 1,
      left: (600 - phoneScreen.width) / 2,
      top: (1200 - phoneScreen.height) / 2,
    })
    expect(phoneTravel(1200, 1)).toBe(0)
  })

  it("moves from its top bezel a margin down to its bottom bezel a margin up", () => {
    const height = 500
    const scale = 1
    const travel = phoneTravel(height, scale)
    expect(travel).toBe(phoneScreen.height + 2 * phoneBezel + 2 * phoneMargin - height)
    const top = phoneAt(600, height, scale, 0)
    expect(top.top - phoneBezel).toBe(phoneMargin)
    const bottom = phoneAt(600, height, scale, 1)
    expect(bottom.top + phoneScreen.height * scale + phoneBezel).toBe(height - phoneMargin)
    // Past either end it goes no further.
    expect(phoneAt(600, height, scale, 5).top).toBe(bottom.top)
    expect(phoneAt(600, height, scale, -5).top).toBe(top.top)
  })

  it("keeps what's under the pointer where it is as it zooms, so far as it can", () => {
    const from = framingOf("phone", 520, 560)!
    const scale = 1.2
    const y = 300
    const lift = liftAbout(from, scale, y, 560)
    const to = phoneAt(520, 560, scale, lift)
    const under = (y - from.top) / from.scale
    // Short of either end of its travel, the same pixel of the phone is under the pointer.
    expect(lift).toBeGreaterThan(0)
    expect(lift).toBeLessThan(1)
    expect(to.top + under * scale).toBeCloseTo(y, 6)
    expect(liftAbout(from, scale, -1000, 560)).toBe(0)
    expect(liftAbout(from, scale, 5000, 560)).toBe(1)
  })

  it("is between two as far as it's eased", () => {
    const from = phoneAt(520, 900, 0.5, 0)
    const to = phoneAt(520, 900, 1.2, 0)
    expect(between(from, to, 0)).toEqual(from)
    expect(between(from, to, 1)).toEqual(to)
    expect(between(from, to, 0.5).scale).toBeCloseTo(0.85, 6)
  })

  it("eases in and out, from 0 to 1", () => {
    expect(easeOf(0)).toBe(0)
    expect(easeOf(1)).toBe(1)
    expect(easeOf(0.5)).toBe(0.5)
    expect(easeOf(0.1)).toBeLessThan(0.1)
    expect(easeOf(0.9)).toBeGreaterThan(0.9)
  })
})

describe("a zoomed phone's rail", () => {
  it("is as long as the viewer less its ends, its thumb the share of the phone in view", () => {
    const height = 500
    const scale = 1
    const rail = railOf(height, scale, 0)!
    expect(rail.length).toBe(height - 2 * railEnd)
    const travel = phoneTravel(height, scale)
    expect(rail.thumb).toBeCloseTo((rail.length * height) / (height + travel), 6)
    expect(rail.at).toBe(0)
    expect(railOf(height, scale, 1)!.at).toBeCloseTo(rail.length - rail.thumb, 6)
    // Half way along, half way down the track.
    expect(railOf(height, scale, 0.5)!.at).toBeCloseTo((rail.length - rail.thumb) / 2, 6)
  })

  it("is none for a phone no taller than the viewer", () => {
    expect(railOf(1200, 1, 0.5)).toBeUndefined()
  })

  it("keeps its thumb long enough to take hold of", () => {
    expect(railOf(300, 4, 0)!.thumb).toBeGreaterThanOrEqual(28)
  })

  it("maps a pointer on the track to the lift, with the thumb's middle under it", () => {
    const length = 400
    const thumb = 100
    expect(liftAtRail(50, 0, length, thumb)).toBe(0)
    expect(liftAtRail(350, 0, length, thumb)).toBe(1)
    expect(liftAtRail(200, 0, length, thumb)).toBeCloseTo(0.5, 6)
    // Past either end of the track, or on one with no room to move.
    expect(liftAtRail(-50, 0, length, thumb)).toBe(0)
    expect(liftAtRail(900, 0, length, thumb)).toBe(1)
    expect(liftAtRail(20, 0, 80, 100)).toBe(0)
    // The rail's own lift is where its thumb is drawn, whichever way round.
    for (const lift of [0, 0.25, 0.8, 1]) {
      const rail = railOf(500, 1, lift)!
      expect(liftAtRail(rail.at + rail.thumb / 2, 0, rail.length, rail.thumb)).toBeCloseTo(lift, 6)
    }
  })
})
