import { afterAll, beforeAll } from "vitest"

import { daysAway, farClock, farDay, nextDayChange } from "./far-clock"
import { context, describe, expect, it } from "./test"
import { hour } from "./units"

// The calendar is the viewer's local one, so these run in a zone with a clock change in March.
const zone = process.env.TZ
beforeAll(() => {
  process.env.TZ = "Europe/London"
})
afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

const at = (month: number, day: number, hours = 0, minutes = 0): number =>
  new Date(2026, month - 1, day, hours, minutes).getTime()
const clock = (time: number): string => {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}
const weekday = (time: number): string =>
  new Date(time).toLocaleDateString(undefined, { weekday: "short" })

describe("a time on another day", () => {
  context("counted by the calendar, not by 24 hours", () => {
    it("is today until local midnight, whatever the time left", () => {
      expect(daysAway(at(10, 7, 23, 59), at(10, 7, 0, 1))).toBe(0)
      expect(farClock(at(10, 7, 23, 59), at(10, 7, 0, 1), clock)).toBeUndefined()
      expect(farDay(at(10, 7, 23, 59), at(10, 7, 0, 1))).toBeUndefined()
    })

    it("is tomorrow past midnight, though it is hours away", () => {
      const now = at(10, 7, 22)
      const tomorrow = at(10, 8, 8)
      expect(tomorrow - now).toBe(10 * hour)
      expect(daysAway(tomorrow, now)).toBe(1)
      expect(farClock(tomorrow, now, clock)).toBe(`${weekday(tomorrow)} 08:00`)
      expect(farDay(tomorrow, now)).toBe(weekday(tomorrow))
    })

    it("is tomorrow across the clock change, where the day has 23 hours", () => {
      // The clocks go forward on Sunday 29 March: 10:00 on Saturday to 10:30 on Sunday is 23.5 hours,
      // which read as hours alone would be today.
      const now = at(3, 28, 10)
      const later = at(3, 29, 10, 30)
      expect((later - now) / hour).toBe(23.5)
      expect(daysAway(later, now)).toBe(1)
      expect(farClock(later, now, clock)).toBe(`${weekday(later)} 10:30`)
      // And back: the day the clocks go back has 25.
      const back = at(10, 24, 10)
      const next = at(10, 25, 10, 30)
      expect(next - back).toBeGreaterThan(24 * hour)
      expect(daysAway(next, back)).toBe(1)
      expect(daysAway(at(10, 25, 23, 30), at(10, 25, 0, 30))).toBe(0)
    })

    it("names the weekday up to five days off, and counts the days from six", () => {
      const now = at(10, 7, 14)
      expect(farClock(at(10, 12, 9), now, clock)).toBe(`${weekday(at(10, 12))} 09:00`)
      expect(farClock(at(10, 13, 9), now, clock)).toBe("in 6d · 09:00")
      expect(farDay(at(10, 12, 9), now)).toBe(weekday(at(10, 12)))
      expect(farDay(at(10, 13, 9), now)).toBe("in 6d")
      expect(farClock(at(10, 14, 9), now, clock)).toBe("in 7d · 09:00")
    })

    it("is today for a time that has passed", () => {
      expect(daysAway(at(10, 6, 9), at(10, 7, 14))).toBe(0)
    })
  })

  it("reads otherwise next at the next local midnight, and not at all today", () => {
    expect(nextDayChange(at(10, 12, 9), at(10, 7, 14))).toBe(at(10, 8))
    // Across the clock change the midnight is the local one: 29 March starts at 00:00 GMT.
    expect(nextDayChange(at(4, 2, 9), at(3, 28, 22))).toBe(at(3, 29))
    expect(nextDayChange(at(4, 2, 9), at(3, 29, 12))).toBe(at(3, 30))
    expect(nextDayChange(at(10, 7, 20), at(10, 7, 14))).toBeUndefined()
  })
})
