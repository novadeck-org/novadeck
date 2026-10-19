import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"

import type { Data } from "./envelope.js"
import type { Log } from "./logger.js"

/** What the marker of a running launch holds. */
type Marker = { readonly sid: string; readonly startedAt: string }

const readMarker = (file: string): Marker | undefined => {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (typeof value !== "object" || value === null) return undefined
    const { sid, startedAt } = value as Record<string, unknown>
    return typeof sid === "string" && typeof startedAt === "string" ? { sid, startedAt } : undefined
  } catch {
    return undefined
  }
}

/** How much of a log's end is read for the last line of a launch, in bytes. */
const tailBytes = 64 * 1024

/** When the last line of launch `sid` in the log `file` was written, if it is near the file's end. */
export const lastSeen = (file: string, sid: string): string | undefined => {
  let fd: number | undefined
  try {
    const size = statSync(file).size
    const length = Math.min(size, tailBytes)
    const buffer = Buffer.alloc(length)
    fd = openSync(file, "r")
    readSync(fd, buffer, 0, length, size - length)
    const lines = buffer.toString("utf8").split("\n").toReversed()
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as { sid?: unknown; t?: unknown }
        if (value.sid === sid && typeof value.t === "string") return value.t
      } catch {
        // A line cut by the read's start, or by the crash.
      }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export type Session = {
  /** Logs `session.start` with what the launch is, once it is known. Once. */
  start(data?: Data): void
  /** Logs `session.end` with the exit's facts, and marks the launch as having ended. Once. */
  end(data?: Data): void
}

/**
 * Opens a launch's records, synchronously, as early as the process can: `session.unclean`
 * for the launch before it, when that one left its `marker` behind, as a launch that never
 * ended does, killed or crashed; then this launch's marker, its folder made first. A launch
 * that crashes before it says what it is (`start`), or straight after, is found by the next
 * all the same. `file` is the log's, read for when the unclean launch last wrote.
 *
 * One process owns a launch's marker, the one whose end is the launch's: a process started
 * within the launch, and again, never touches it, or its own end would hide the launch's.
 */
export const openSession = (options: {
  /** The file that marks a launch as running, such as `logs/session.json`. */
  readonly marker: string
  readonly sid: string
  readonly log: Log
  readonly file?: string
  readonly now?: () => number
}): Session => {
  const { marker, sid, log } = options
  const now = options.now ?? Date.now
  const previous = readMarker(marker)
  if (previous && previous.sid !== sid) {
    const last = options.file && lastSeen(options.file, previous.sid)
    log.warn("session.unclean", "The last launch ended without closing its log.", {
      data: {
        sid: previous.sid,
        startedAt: previous.startedAt,
        ...(last && { lastAt: last }),
      },
    })
  }
  try {
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, JSON.stringify({ sid, startedAt: new Date(now()).toISOString() }))
  } catch {
    // Without a marker the next launch can't tell how this one ended.
  }
  let started = false
  let ended = false
  return {
    start(data) {
      if (started) return
      started = true
      log.info("session.start", "The app started.", { ...(data && { data }) })
    },
    end(data) {
      if (ended) return
      ended = true
      log.info("session.end", "The app quit.", { ...(data && { data }) })
      try {
        if (readMarker(marker)?.sid === sid) rmSync(marker, { force: true })
      } catch {
        // Held by another program a moment: the next launch reads this one as unclean, its
        // end logged all the same.
      }
    },
  }
}
