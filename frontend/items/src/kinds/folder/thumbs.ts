import type { FilePart } from "@novadeck/core/items"

import { entryThumbRenderer, type FolderEntryKind } from "./entry-thumbs"
import "./thumb-renderers"

// The pictures of a folder's grid: each is read through the runner's `companions.part`, as the
// kind's own viewer would read the file, a few at a time and the nearest to the middle of the
// view first, and kept for a while by the file's stamp, so a grid that comes back draws at once.

export type Thumb = {
  // An address the page can draw.
  readonly url: string
  // A video's length in seconds, where it was learned.
  readonly duration: number | undefined
}

type Job = {
  readonly distance: () => number
  readonly run: (signal: AbortSignal) => Promise<void>
  readonly stop: AbortController
}

// Runs `limit` jobs at a time, the one nearest first (by its own measure, taken when a place
// frees, as what is near changes while the grid scrolls).
export type Queue = {
  // Asks for a job; the function it gives back withdraws it, aborting it if it is running.
  readonly want: (distance: () => number, run: (signal: AbortSignal) => Promise<void>) => () => void
}

export const createQueue = (limit = 3): Queue => {
  const waiting = new Set<Job>()
  let running = 0
  const next = (): void => {
    while (running < limit && waiting.size > 0) {
      let nearest: Job | undefined
      let best = Infinity
      for (const job of waiting) {
        const away = job.distance()
        if (away < best) {
          best = away
          nearest = job
        }
      }
      if (!nearest) return
      waiting.delete(nearest)
      running += 1
      const job = nearest
      void job
        .run(job.stop.signal)
        .catch(() => {})
        .finally(() => {
          running -= 1
          next()
        })
    }
  }
  return {
    want: (distance, run) => {
      const job: Job = { distance, run, stop: new AbortController() }
      waiting.add(job)
      next()
      return () => {
        waiting.delete(job)
        job.stop.abort()
      }
    },
  }
}

// What the pictures kept so far are, by key, the oldest first; a picture let go is revoked.
// A file with no picture (a renderer answered null, failed or ran out of time) is kept as null, so
// that its renderer is asked once for the file as its stamp names it, not at each scroll back;
// unless a read of it failed or was still on its way, which says nothing of the file.
const kept = new Map<string, Thumb | null>()
const keptMost = 300

export const keptThumb = (key: string): Thumb | undefined => {
  const thumb = kept.get(key)
  if (thumb === undefined) return undefined
  kept.delete(key)
  kept.set(key, thumb)
  return thumb ?? undefined
}

/** Whether the file as `key` names it was asked for a picture, and has none. */
export const hasNoThumb = (key: string): boolean => kept.get(key) === null

// How many tiles show each picture, by its URL, and the ones let go of while shown: a picture is
// revoked once it is neither kept nor shown.
const shown = new Map<string, number>()
const letGo = new Set<string>()

const revokeUnused = (url: string): void => {
  if (shown.has(url)) return void letGo.add(url)
  letGo.delete(url)
  URL.revokeObjectURL(url)
}

/** A tile shows the picture at `url` until the function it gets back is called. */
export const holdThumb = (url: string): (() => void) => {
  shown.set(url, (shown.get(url) ?? 0) + 1)
  let held = true
  return () => {
    if (!held) return
    held = false
    const left = (shown.get(url) ?? 1) - 1
    if (left > 0) return void shown.set(url, left)
    shown.delete(url)
    if (letGo.has(url)) revokeUnused(url)
  }
}

const keep = (key: string, thumb: Thumb | null): void => {
  const replaced = kept.get(key)
  kept.delete(key)
  kept.set(key, thumb)
  // Two tiles of one file that loaded at once: the first picture is no longer kept.
  if (replaced && replaced.url !== thumb?.url) revokeUnused(replaced.url)
  for (const [oldest, was] of kept) {
    if (kept.size <= keptMost) break
    kept.delete(oldest)
    if (was) revokeUnused(was.url)
  }
}

// How long a renderer has to draw a picture before it is stopped and the icon is shown, so one
// that never settles takes no place in the queue for good.
export const thumbDeadlineMs = 15_000

// The box a picture is drawn in, which a renderer fits its picture to.
const box = { width: 320, height: 200 }

// Reads a file of the folder and makes its picture with what its kind registered (see
// ./entry-thumbs): kept by `key`, with its length where it has one. Undefined where it can't be
// drawn, failed, ran out of `deadline` or was stopped: the grid shows the kind's icon, and a file
// that had none is not asked again as its stamp names it. One that was stopped is, and so is one
// whose read failed (a link that dropped, a runner that restarted, a file it couldn't read then)
// or was still on its way at the deadline (a slow link). `read` is the backend's part read of
// the file: a stopped renderer asks for no more parts, and what it asked for is dropped.
export const loadThumb = async ({
  key,
  kind,
  name,
  size,
  read,
  signal,
  deadline = thumbDeadlineMs,
}: {
  readonly key: string
  readonly kind: FolderEntryKind
  readonly name: string
  readonly size: number
  readonly read: (offset: number, signal: AbortSignal) => Promise<FilePart>
  readonly signal: AbortSignal
  readonly deadline?: number
}): Promise<Thumb | undefined> => {
  const render = entryThumbRenderer(kind)
  if (!render) return undefined
  // The renderer's own signal: aborted when the caller's is, and when its time is up.
  const own = new AbortController()
  const outer = (): void => own.abort()
  signal.addEventListener("abort", outer, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  // Settles however the renderer behaves: with it, with nothing when it fails, or at the deadline or
  // the caller's stopping, whichever comes first.
  const ended = new Promise<"late" | "stopped">((resolve) => {
    timer = setTimeout(() => {
      own.abort()
      resolve("late")
    }, deadline)
    own.signal.addEventListener("abort", () => resolve(signal.aborted ? "stopped" : "late"), {
      once: true,
    })
  })
  // Whether a read failed, and how many are on their way: then no picture says nothing of the file.
  let failed = false
  let pending = 0
  const reading = async (offset: number, stop: AbortSignal): Promise<FilePart> => {
    pending += 1
    try {
      const part = await read(offset, stop)
      if (part.state === "unavailable" && part.reason === "unreadable") failed = true
      return part
    } catch (error) {
      failed = true
      throw error
    } finally {
      pending -= 1
    }
  }
  try {
    const made = await Promise.race([
      render({ name, size, read: reading }, box, own.signal).catch(() => null),
      ended,
    ])
    if (made === "stopped" || signal.aborted) return undefined
    if (made === "late" || made === null) {
      if (!failed && (made === null || pending === 0)) keep(key, null)
      return undefined
    }
    const thumb = { url: URL.createObjectURL(made.blob), duration: made.duration }
    keep(key, thumb)
    return thumb
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", outer)
    own.abort()
  }
}
