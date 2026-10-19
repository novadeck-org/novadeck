import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import type { Data } from "./envelope.js"
import type { Log } from "./logger.js"

/** What the marker of a running launch holds. */
type Marker = { readonly sid: string; readonly startedAt: string }

const markerName = "session.json"

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
  /** Logs `session.end` with the exit's facts, and marks the launch as having ended. Once. */
  end(data?: Data): void
}

/**
 * Starts a launch's records: `session.unclean` for the launch before it, when that one left
 * its marker (`session.json` in `folder`), as a launch that never ended does, killed or
 * crashed; then `session.start`, with `data`. The marker is written at once, so even a launch
 * killed straight after is found by the next. `log` is the log's file, read for when the
 * unclean launch last wrote.
 */
export const startSession = (options: {
  readonly folder: string
  readonly sid: string
  readonly log: Log
  readonly file?: string
  readonly data?: Data
  readonly now?: () => number
}): Session => {
  const { folder, sid, log } = options
  const now = options.now ?? Date.now
  const marker = join(folder, markerName)
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
    writeFileSync(marker, JSON.stringify({ sid, startedAt: new Date(now()).toISOString() }))
  } catch {
    // Without a marker the next launch can't tell how this one ended.
  }
  log.info("session.start", "The app started.", { ...(options.data && { data: options.data }) })
  let ended = false
  return {
    end(data) {
      if (ended) return
      ended = true
      log.info("session.end", "The app quit.", { ...(data && { data }) })
      const current = readMarker(marker)
      if (current?.sid === sid) rmSync(marker, { force: true })
    },
  }
}
