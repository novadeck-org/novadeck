import type { Entry } from "./envelope.js"

/** A line held back as a repeat, and how many times it came again. */
type Held = {
  readonly entry: Entry
  readonly firstAt: number
  readonly count: number
  readonly lastT: string
}

/** The lines seen lately, by what makes two of them the same. */
export type Repeats = ReadonlyMap<string, Held>

/** The repeats to remember next, and the lines to write now. */
type Collapsed = { readonly repeats: Repeats; readonly write: readonly Entry[] }

/** How many different lines are remembered at once; the oldest is let go past it. */
const maxRemembered = 256

/** What makes two lines the same: all but their time. */
const keyOf = (entry: Entry): string =>
  JSON.stringify([entry.level, entry.src, entry.evt, entry.msg, entry.data, entry.err?.message])

/** The line that says how often `held` came again. */
const summary = (held: Held): Entry => ({
  ...held.entry,
  t: held.lastT,
  evt: "log.repeated",
  msg: `${held.entry.msg ?? held.entry.evt} (repeated ${held.count} more ${held.count === 1 ? "time" : "times"})`,
  data: { evt: held.entry.evt, count: held.count, since: held.entry.t },
})

/**
 * The lines due from `repeats` at `now`: a summary of each line that came again and whose
 * window is over. What is left is remembered.
 */
export const due = (repeats: Repeats, now: number, windowMs: number): Collapsed => {
  const kept = new Map<string, Held>()
  const write: Entry[] = []
  for (const [key, held] of repeats) {
    if (now - held.firstAt < windowMs) kept.set(key, held)
    else if (held.count > 0) write.push(summary(held))
  }
  return { repeats: kept, write }
}

/**
 * What to write for `entry` at `now`: it, the first time it comes in a window of
 * `windowMs`, and nothing while it comes again within it, which is counted and said once the
 * window is over (see `due`). A fatal line is always written.
 */
export const collapse = (
  repeats: Repeats,
  entry: Entry,
  now: number,
  windowMs: number,
): Collapsed => {
  const settled = due(repeats, now, windowMs)
  if (entry.level === "fatal" || windowMs <= 0)
    return { repeats: settled.repeats, write: [...settled.write, entry] }
  const key = keyOf(entry)
  const held = settled.repeats.get(key)
  const next = new Map(settled.repeats)
  if (held) {
    next.set(key, { ...held, count: held.count + 1, lastT: entry.t })
    return { repeats: next, write: settled.write }
  }
  const write = [...settled.write]
  if (next.size >= maxRemembered) {
    const [oldest] = next
    if (oldest) {
      next.delete(oldest[0])
      if (oldest[1].count > 0) write.push(summary(oldest[1]))
    }
  }
  next.set(key, { entry, firstAt: now, count: 0, lastT: entry.t })
  return { repeats: next, write: [...write, entry] }
}

/** A summary of every line still held as a repeat, as when the log closes. */
export const drain = (repeats: Repeats): readonly Entry[] =>
  [...repeats.values()].filter((held) => held.count > 0).map(summary)
