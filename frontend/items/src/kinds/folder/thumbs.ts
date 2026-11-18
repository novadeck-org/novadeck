import type { FilePart } from "@novadeck/core/items"

import { loadParts } from "../../parts/load"

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

const keep = (key: string, thumb: Thumb): void => {
  kept.set(key, thumb)
  for (const [oldest, was] of kept) {
    if (kept.size <= keptMost) break
    kept.delete(oldest)
    URL.revokeObjectURL(was.url)
  }
}

export const mimeOfImage = (name: string): string => {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
  return (
    (
      {
        png: "image/png",
        apng: "image/apng",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        jfif: "image/jpeg",
        pjpeg: "image/jpeg",
        pjp: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        avif: "image/avif",
        bmp: "image/bmp",
        ico: "image/x-icon",
        cur: "image/x-icon",
        svg: "image/svg+xml",
      } as Record<string, string | undefined>
    )[extension] ?? "application/octet-stream"
  )
}

// The widest a video's frame is drawn.
const frameWidth = 320

// A video's first moment, drawn small, and its length; undefined where the page can't play it.
const frameOf = (
  video: Blob,
): Promise<{ readonly picture: Blob; readonly duration: number } | undefined> =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(video)
    const element = document.createElement("video")
    element.muted = true
    element.preload = "auto"
    const done = (
      result: { readonly picture: Blob; readonly duration: number } | undefined,
    ): void => {
      clearTimeout(timer)
      element.removeAttribute("src")
      element.load()
      URL.revokeObjectURL(url)
      resolve(result)
    }
    const timer = setTimeout(() => done(undefined), 10_000)
    element.addEventListener("error", () => done(undefined))
    element.addEventListener("loadedmetadata", () => {
      // A moment in, past a fade from black, where the video is long enough.
      element.currentTime = Math.min(1, (element.duration || 0) / 10)
    })
    element.addEventListener("seeked", () => {
      const { videoWidth: width, videoHeight: height } = element
      if (!width || !height) return done(undefined)
      const canvas = document.createElement("canvas")
      canvas.width = Math.min(frameWidth, width)
      canvas.height = Math.round((canvas.width * height) / width)
      canvas.getContext("2d")?.drawImage(element, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(
        (picture) =>
          done(
            picture && Number.isFinite(element.duration)
              ? { picture, duration: element.duration }
              : undefined,
          ),
        "image/jpeg",
        0.72,
      )
    })
    element.src = url
  })

// Reads a file of the folder and makes its picture: an image is itself, a video its first
// frame. `read` is the backend's part read for it; undefined where it can't be drawn (too
// large, unreadable, changed while it was read: the grid shows the kind's icon).
export const loadThumb = async ({
  key,
  kind,
  name,
  size,
  read,
  signal,
}: {
  readonly key: string
  readonly kind: "image" | "video"
  readonly name: string
  readonly size: number
  readonly read: (offset: number) => Promise<FilePart>
  readonly signal: AbortSignal
}): Promise<Thumb | undefined> => {
  const loaded = await loadParts({
    read,
    size,
    mime: kind === "image" ? mimeOfImage(name) : "video/mp4",
    signal,
    progress: () => {},
  })
  if (loaded.state !== "ready") return undefined
  if (kind === "image") {
    const thumb = { url: URL.createObjectURL(loaded.blob), duration: undefined }
    keep(key, thumb)
    return thumb
  }
  const frame = await frameOf(loaded.blob)
  if (!frame || signal.aborted) return undefined
  const thumb = { url: URL.createObjectURL(frame.picture), duration: frame.duration }
  keep(key, thumb)
  return thumb
}
