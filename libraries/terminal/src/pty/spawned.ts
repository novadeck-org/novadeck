import { readFile } from "node:fs/promises"

import { processListing, withBelow, type Listed, type Listing } from "./descendants.js"
import type { ProcessTrees } from "./pty.js"
import { relayMs, type Member } from "./trees.js"

/** A live process under a root, named by its pid and start together. */
export type Spawn = {
  /**
   * `${pid}:${startedMs}`, stable for one process across looks; on Linux the start is its raw
   * clock ticks instead, as `startedMs` follows the wall clock and moves when it is set.
   */
  readonly key: string
  readonly pid: number
  /** Null where the OS or the relay didn't tell. */
  readonly parent: number | null
  /** Its program's file name; null if unknown. */
  readonly name: string | null
  /** Epoch milliseconds, at the OS's resolution (`startResolutionMs`). */
  readonly startedMs: number
  /**
   * Whether it is in the foreground process group of the root's terminal, which an agent and
   * its launcher are in and the commands it runs for the person are not; undefined where
   * groups aren't told (Windows) or the root has no foreground.
   */
  readonly inForeground?: boolean
}

/**
 * How coarse `startedMs` is on `platform`, in milliseconds: what a caller subtracts from a
 * moment so a process started in its own tick still counts. Linux counts clock ticks of
 * 10 ms (CLK_TCK is 100 on every Linux Node runs on); macOS's `ps` gives whole seconds;
 * Windows takes the creation time from a system clock that ticks every 15.6 ms, which the
 * relay passes on in whole milliseconds.
 */
export const startResolutionMs = (platform: NodeJS.Platform = process.platform): number =>
  platform === "linux" ? 10 : platform === "win32" ? 16 : 1000

const ticksMs = 1000 / 100

/** How long the system has been up, in ms; undefined where it can't be read. */
const readUptimeMs = async (): Promise<number | undefined> => {
  try {
    const up = Number.parseFloat(await readFile("/proc/uptime", "utf8"))
    return Number.isFinite(up) ? up * 1000 : undefined
  } catch {
    return undefined
  }
}

/** The epoch ms of macOS's `lstart` (`Fri Nov  6 15:20:11 2026`, local time); undefined if it isn't one. */
export const parseLstart = (lstart: string): number | undefined => {
  const match = /^\w+\s+(\w+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)$/.exec(lstart.trim())
  if (!match) return undefined
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const at = month.indexOf(match[1]!)
  if (at < 0) return undefined
  const [day, hour, minute, second, year] = match.slice(2).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ]
  return new Date(year, at, day, hour, minute, second).getTime()
}

const spawn = (
  pid: number,
  parent: number | null,
  name: string | null,
  startedMs: number,
  start: string | number = startedMs,
  inForeground?: boolean,
): Spawn => ({
  key: `${pid}:${start}`,
  pid,
  parent,
  name,
  startedMs,
  ...(inForeground === undefined ? {} : { inForeground }),
})

const fromListing = (
  rows: readonly Listed[],
  root: number,
  platform: NodeJS.Platform,
  now: number,
  uptime: number | undefined,
): readonly Spawn[] | undefined => {
  const top = rows.find((row) => row.pid === root)
  if (!top || top.zombie) return undefined
  const found: Spawn[] = []
  for (const row of withBelow(rows, [top])) {
    if (row.pid === root || row.zombie) continue
    const at =
      platform === "linux"
        ? uptime === undefined
          ? undefined
          : now - uptime + Number(row.started) * ticksMs
        : parseLstart(row.started)
    if (at === undefined || !Number.isFinite(at)) continue
    const name = row.command?.split("/").pop() || null
    found.push(
      spawn(
        row.pid,
        row.parent,
        name,
        Math.round(at),
        platform === "linux" ? row.started : undefined,
        top.foreground > 1 ? row.group === top.foreground : undefined,
      ),
    )
  }
  return found
}

const fromTree = (tree: readonly Member[], root: number): readonly Spawn[] =>
  tree
    .filter((member) => member.pid !== root)
    .map((member) =>
      spawn(member.pid, member.parent ?? null, member.name ?? null, member.startedAt),
    )

const listings = new Map<NodeJS.Platform, Listing>()

/**
 * Every live, non-zombie process under `root`, as one look sees them (root itself left out):
 * by /proc on Linux, `ps` on macOS (both shared, so a caller looking each second for a few
 * terminals costs one listing), the relay's tree on Windows, within `listMs` and `relayMs`.
 * Undefined where the system can't tell: no listing, a relay that is missing or fails, or a
 * root that has ended. A process whose start can't be read is left out.
 */
export const processesUnder = async (
  root: number,
  options: {
    readonly platform?: NodeJS.Platform
    readonly listing?: Listing
    readonly trees?: Pick<ProcessTrees, "read">
    /** How long the system has been up, in ms, where Linux's /proc/uptime isn't read. */
    readonly uptimeMs?: () => Promise<number | undefined>
  } = {},
): Promise<readonly Spawn[] | undefined> => {
  const platform = options.platform ?? process.platform
  if (platform === "win32") {
    const tree = await options.trees?.read(root, relayMs)
    // The root is first in a tree it is in; one that has ended leaves none.
    return tree?.some((member) => member.pid === root) ? fromTree(tree, root) : undefined
  }
  let listing = options.listing
  if (!listing) {
    listing = listings.get(platform) ?? processListing(platform)
    listings.set(platform, listing)
  }
  const rows = await listing()
  if (!rows) return undefined
  // Read at each look, with the clock, as the boot moment moves when the wall clock is set.
  const uptime = platform === "linux" ? await (options.uptimeMs ?? readUptimeMs)() : undefined
  if (platform === "linux" && uptime === undefined) return undefined
  return fromListing(rows, root, platform, Date.now(), uptime)
}
