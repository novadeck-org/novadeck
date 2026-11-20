import { endFollowed, type Followed, type Listed, type Listing } from "./descendants.js"
import { parseLstart } from "./spawned.js"
import { relayMs, type Member } from "./trees.js"

/**
 * A process a harness runs apart from a terminal, as the harness recorded it (harness-core's
 * `ApartProcess`): `start` as Linux's /proc/<pid>/stat holds it or macOS's `ps -o lstart`
 * gives it in UTC; `born`, the milliseconds since the epoch between which it started, for
 * Windows, where only that is read.
 */
export type ApartProcess = {
  readonly pid: number
  readonly start?: string
  readonly born: { readonly after: number; readonly before: number }
}

// `ps -o lstart` as macOS gives it under LC_ALL=C and TZ=UTC: "Fri Nov 20 12:49:08 2026".
const utcLstart = (lstart: string): number | undefined => {
  const local = parseLstart(lstart)
  if (local === undefined) return undefined
  const at = new Date(local)
  return Date.UTC(
    at.getFullYear(),
    at.getMonth(),
    at.getDate(),
    at.getHours(),
    at.getMinutes(),
    at.getSeconds(),
  )
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
  if (row.pid !== apart.pid || row.zombie || apart.start === undefined) return false
  if (platform === "linux") return row.started === apart.start
  if (words(row.started) === words(apart.start)) return true
  const listed = parseLstart(row.started)
  return listed !== undefined && listed === utcLstart(apart.start)
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

/**
 * Ends `apart` with all each runs, now: what a harness named as its own to end once a
 * terminal closed. On Linux and macOS as a closed terminal's followed processes are
 * ended (`endFollowed`, with no wait), each found in a listing by its start; on Windows each
 * one's tree, read through the relay, whose root started within its `born`. One that isn't
 * the process recorded, or that can't be looked at, is left: nothing is ended by pid alone.
 */
export const endApart = async (
  apart: readonly ApartProcess[],
  options: {
    readonly platform: NodeJS.Platform
    readonly listing: Listing
    readonly trees: {
      read(root: number, timeoutMs?: number): Promise<readonly Member[] | undefined>
      end(members: readonly Member[], timeoutMs?: number): Promise<void>
    }
    /** How long one relay run may take, given its usual bound. */
    readonly run?: (usual: number) => number
  },
): Promise<void> => {
  if (apart.length === 0) return
  const { platform, listing, trees, run = (usual) => usual } = options
  if (platform !== "win32") {
    const rows = await listing()
    if (!rows) {
      console.error(
        "Listing the processes failed, so these a closed terminal's agent left apart were not ended:",
        apart.map(({ pid }) => pid).join(", "),
      )
      return
    }
    const found = listedApart(rows, apart, platform)
    if (found.length > 0) await endFollowed(found, () => Date.now(), listing)
    return
  }
  const read = await Promise.all(apart.map((one) => trees.read(one.pid, run(relayMs))))
  const members = apart.flatMap((one, at) => {
    const tree = read[at]
    const root = tree?.find((member) => member.pid === one.pid)
    return tree && root && root.startedAt >= one.born.after && root.startedAt <= one.born.before
      ? tree
      : []
  })
  const unique = new Map(members.map((member) => [`${member.pid}:${member.startedAt}`, member]))
  if (unique.size > 0) await trees.end([...unique.values()], run(relayMs))
}
