import type { TerminalMetadata } from "../types"
import { day, hour, minute } from "../units"

// When the agent's latest turn ended, where its harness tells it, or, for a sleeper, the
// runner kept it.
const endedAt = (terminal: TerminalMetadata): number | undefined =>
  terminal.state === "running"
    ? terminal.agent?.lastTurn?.at
    : terminal.state === "sleeping"
      ? terminal.endedAt
      : undefined

// The unit an age counts in at `elapsed`: minutes for the first hour, hours for the first
// day, days after.
const unitOf = (elapsed: number): number => (elapsed < hour ? minute : elapsed < day ? hour : day)

// How long ago the agent's latest turn ended, short, for its tab beside the program:
// "now" within the first minute, then "4m", "2h", "3d". Undefined where its harness
// doesn't tell when.
export const turnAge = (terminal: TerminalMetadata, now = Date.now()): string | undefined => {
  const at = endedAt(terminal)
  return at === undefined ? undefined : shortAge(at, now)
}

// How long ago `at` was, short, as a tab says its turn's age: "now" within the first minute,
// then "4m", "2h", "3d".
export const shortAge = (at: number, now = Date.now()): string => {
  const elapsed = Math.max(0, now - at)
  if (elapsed < minute) return "now"
  const unit = unitOf(elapsed)
  const suffix = unit === minute ? "m" : unit === hour ? "h" : "d"
  return `${Math.floor(elapsed / unit)}${suffix}`
}

// When that short age next changes, so a view can render it again.
export const nextShortAge = (at: number, now = Date.now()): number => {
  const elapsed = Math.max(0, now - at)
  const unit = unitOf(elapsed)
  return at + (Math.floor(elapsed / unit) + 1) * unit
}

// When that age next changes, so a view can render it again; undefined without one.
export const nextTurnAge = (terminal: TerminalMetadata, now = Date.now()): number | undefined => {
  const at = endedAt(terminal)
  return at === undefined ? undefined : nextShortAge(at, now)
}
