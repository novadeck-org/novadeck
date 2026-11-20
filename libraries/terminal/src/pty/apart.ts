import type { Followed, Listed } from "./descendants.js"
import { parseLstart } from "./spawned.js"

/**
 * A process a harness runs apart from a terminal, as the harness recorded it (harness-core's
 * `ApartProcess`): `start` as Linux's /proc/<pid>/stat holds it or as macOS's `ps -o lstart`
 * gives it in UTC.
 */
export type ApartProcess = { readonly pid: number; readonly start: string }

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** `ps -o lstart` as macOS gives it under LC_ALL=C and TZ=UTC ("Fri Nov 20 12:49:08 2026"). */
export const parseUtcLstart = (lstart: string): number | undefined => {
  const match = /^\w+\s+(\w+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)$/.exec(lstart.trim())
  const month = match ? months.indexOf(match[1]!) : -1
  if (!match || month < 0) return undefined
  const [day, hour, minute, second, year] = match.slice(2).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ]
  return Date.UTC(year, month, day, hour, minute, second)
}

// A start in `ps -o lstart`'s words, however they are spaced.
const words = (lstart: string): string => lstart.trim().split(/\s+/).join(" ")

/**
 * Whether listed process `row` is `apart` as its harness recorded it: on Linux the same
 * clock ticks; on macOS the same second, as the listing gives its start in the local time
 * and the harness in UTC, or the same words where the harness gave the local time too.
 * Never by pid alone: one that has ended may have given its pid to another.
 */
export const sameProcess = (
  row: Listed,
  apart: ApartProcess,
  platform: NodeJS.Platform,
): boolean => {
  if (row.pid !== apart.pid || row.zombie) return false
  if (platform === "linux") return row.started === apart.start
  if (words(row.started) === words(apart.start)) return true
  const listed = parseLstart(row.started)
  return listed !== undefined && listed === parseUtcLstart(apart.start)
}

/** Which of `apart` the listing shows, each still the process its harness recorded. */
export const listedApart = (
  rows: readonly Listed[],
  apart: readonly ApartProcess[],
  platform: NodeJS.Platform,
): readonly Followed[] =>
  rows
    .filter((row) => apart.some((one) => sameProcess(row, one, platform)))
    .map(({ pid, started }) => ({ pid, started }))
