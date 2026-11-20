import { day } from "./units"

// A moment's local calendar day, as a count of days since the epoch, where days are the
// calendar's and not 24 hours: a clock change makes a day 23 or 25 hours long.
const calendarDay = (at: number): number => {
  const date = new Date(at)
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / day)
}

/** How many calendar days from `now`'s local day to `at`'s: 0 today, 1 tomorrow; 0 for the past. */
export const daysAway = (at: number, now: number): number =>
  Math.max(0, calendarDay(at) - calendarDay(now))

// From this many days on a weekday alone could be today's, so the days are counted instead.
const countedFrom = 6

/**
 * A time on another day than today's, as people say it with `clock` (the time of day): the
 * weekday and time, "Thu 09:00", and from six days on the days counted, "in 6d · 09:00". By the
 * calendar: 08:00 tomorrow is "Thu 08:00" at 22:00 tonight, though it is ten hours away, and
 * across a clock change. Undefined today, where the time of day alone is enough and each text says
 * it its own way. One rule for the footer's resets and the tab's.
 */
export const farClock = (
  at: number,
  now: number,
  clock: (at: number) => string,
): string | undefined => {
  const days = daysAway(at, now)
  if (days === 0) return undefined
  if (days >= countedFrom) return `in ${days}d · ${clock(at)}`
  return `${new Date(at).toLocaleDateString(undefined, { weekday: "short" })} ${clock(at)}`
}

/**
 * The same for a narrow chip, which has no room for the time: the weekday alone, "Thu", and from
 * six days on the days counted, "in 6d". Undefined today.
 */
export const farDay = (at: number, now: number): string | undefined => {
  const days = daysAway(at, now)
  if (days === 0) return undefined
  if (days >= countedFrom) return `in ${days}d`
  return new Date(at).toLocaleDateString(undefined, { weekday: "short" })
}

/**
 * When a text that says `at` by `farClock` next reads otherwise: the next local midnight, where
 * the days to it count down, if it is another day's; undefined today, or once it has passed.
 */
export const nextDayChange = (at: number, now: number): number | undefined => {
  if (daysAway(at, now) === 0) return undefined
  const midnight = new Date(now)
  midnight.setHours(24, 0, 0, 0)
  return midnight.getTime()
}
