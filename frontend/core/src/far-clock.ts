import { day, minute } from "./units"

const minutesPerDay = day / minute

/**
 * A time a day or more away, as people say it with `clock` (the time of day): the weekday and
 * time, "Thu 09:00", and from six days on the days counted, "in 6d · 09:00", since by then a
 * weekday alone could be today's. Undefined within a day, where the time of day alone is
 * enough and each text says it its own way. One rule for the footer's resets and the tab's.
 */
export const farClock = (
  at: number,
  now: number,
  clock: (at: number) => string,
): string | undefined => {
  const minutes = Math.max(0, Math.ceil((at - now) / minute))
  if (minutes >= 6 * minutesPerDay)
    return `in ${Math.floor(minutes / minutesPerDay)}d · ${clock(at)}`
  if (minutes >= minutesPerDay)
    return `${new Date(at).toLocaleDateString(undefined, { weekday: "short" })} ${clock(at)}`
  return undefined
}
