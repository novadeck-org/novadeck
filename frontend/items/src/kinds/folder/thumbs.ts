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
const kept = new Map<string, Thumb>()
const keptMost = 300

export const keptThumb = (key: string): Thumb | undefined => {
  const thumb = kept.get(key)
  if (thumb) {
    kept.delete(key)
    kept.set(key, thumb)
  }
  return thumb
}

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

const keep = (key: string, thumb: Thumb): void => {
  kept.set(key, thumb)
  for (const [oldest, was] of kept) {
    if (kept.size <= keptMost) break
    kept.delete(oldest)
    revokeUnused(was.url)
  }
}

// The box a picture is drawn in, which a renderer fits its picture to.
const box = { width: 320, height: 200 }

// Reads a file of the folder and makes its picture with what its kind registered (see
// ./entry-thumbs): kept by `key`, with its length where it has one. Undefined where it can't be
// drawn or it was stopped: the grid shows the kind's icon. `read` is the backend's part read of it.
export const loadThumb = async ({
  key,
  kind,
  name,
  size,
  read,
  signal,
}: {
  readonly key: string
  readonly kind: FolderEntryKind
  readonly name: string
  readonly size: number
  readonly read: (offset: number) => Promise<FilePart>
  readonly signal: AbortSignal
}): Promise<Thumb | undefined> => {
  const render = entryThumbRenderer(kind)
  if (!render) return undefined
  const made = await render({ name, size, read: (offset) => read(offset) }, box, signal).catch(
    () => null,
  )
  if (!made || signal.aborted) return undefined
  const thumb = { url: URL.createObjectURL(made.blob), duration: made.duration }
  keep(key, thumb)
  return thumb
}
