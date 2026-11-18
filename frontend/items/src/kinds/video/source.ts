import type { UnavailableReason } from "@novadeck/core/items"
import { useEffect, useRef, useState } from "react"

import type { ArtifactBodyProps } from "../../ArtifactViewer"
import { blobs } from "../../parts/blobs"
import { loadParts } from "../../parts/load"
import { useRevealed } from "../../store/use-item-store"
import { playable } from "./playable"

// What a video's or a recording's body is given.
export type MediaProps = Pick<
  ArtifactBodyProps<"video" | "audio">,
  "item" | "content" | "stamp" | "itemStore" | "target"
>

// Where a media file's source stands: the URL to play and the stamp of the file it holds, which
// is the last one that played while a newer file's bytes are read (so it plays on until the new
// one is ready); how far that read has got, if it is reading; or why there is nothing to play.
export type Source = {
  readonly url: string | undefined
  readonly stamp: string | undefined
  readonly loaded: number | null
  readonly problem: UnavailableReason | "failed" | "here" | null
}

// The last file of the item that played, by its stamp and URL.
type Good = { readonly stamp: string; readonly url: string }

// What the last read of a file came to, for which file (`key`: the item and its stamp): done,
// as ready (its URL kept) or unplayable with what played before playing on, or a problem.
type Read = { readonly key: string; readonly problem: Source["problem"] }

// How long a file rewritten while something plays must stay as it is before it is read: a
// render writes for a while, and the runner tells each change it sees, so one still being written
// is passed over for the next. Tests set it to 0.
export const timing = { settleMs: 1000 }

// Loads the bytes of a video or a recording while it shows, for the stamp it is at; each new
// stamp reads it afresh, and a pane that comes back finds the last few already loaded, playing
// the item's latest while a newer file is read. A file rewritten while one plays is read once it
// settles, and bytes the browser can't play (a file caught while it was written in place) never
// replace what played: it plays on until the next render. `element` is what the bytes are tried
// on.
export const useSource = (
  { item, content, stamp, itemStore, target }: MediaProps,
  element: "video" | "audio",
): Source => {
  const id = item.id
  const [read, setRead] = useState<Read>()
  const [progress, setProgress] = useState<{ key: string; loaded: number }>()
  // What played last, from the cache where the pane comes back to an item it played before.
  const [good, setGood] = useState<Good | undefined>(() => blobs.latest(id))
  const { part: readPart } = itemStore
  const { size, mime } = content
  // Only the person's yes to a file that may hold secrets reads it.
  const reveal = useRevealed(itemStore, item)
  const key = `${id}:${stamp}`
  // Where it's read for, which a read in progress takes as it is when it asks.
  const where = useRef(target)
  useEffect(() => {
    where.current = target
  })
  // What plays now: this file where it is kept, else the last that played.
  const kept = readPart ? blobs.get(id, stamp) : undefined
  const current = kept ? { stamp, url: kept } : good
  // Whether something plays before this file is read: then the file may still be being written,
  // and bytes that can't play leave it playing.
  const playing = useRef(current)
  useEffect(() => {
    playing.current = current
  })
  useEffect(() => {
    if (!readPart || blobs.get(id, stamp)) return
    const stop = new AbortController()
    const load = async (): Promise<void> => {
      const result = await loadParts({
        read: async (offset) => readPart(where.current, id, { stamp, offset, reveal }),
        size,
        mime,
        signal: stop.signal,
        progress: (loaded) => setProgress({ key, loaded }),
      })
      if (stop.signal.aborted || result.state === "stopped") return
      // A file rewritten while it was read ends the read: the content that follows has a
      // stamp of its own, and reads it again.
      if (result.state === "changed") return setProgress({ key, loaded: 0 })
      if (result.state === "ready") {
        const plays = await playable(result.blob, element)
        if (stop.signal.aborted) return
        if (plays) {
          setGood({ stamp, url: blobs.keep(id, stamp, result.blob) })
          return setRead({ key, problem: null })
        }
        return setRead({ key, problem: playing.current === undefined ? "here" : null })
      }
      setRead({ key, problem: result.state === "failed" ? "failed" : result.reason })
    }
    const wait = playing.current && playing.current.stamp !== stamp ? timing.settleMs : 0
    const timer = setTimeout(() => void load(), wait)
    return () => {
      clearTimeout(timer)
      stop.abort()
    }
  }, [id, key, stamp, size, mime, reveal, readPart, element])
  if (!readPart) return { url: undefined, stamp: undefined, loaded: null, problem: "here" }
  if (kept) return { url: kept, stamp, loaded: null, problem: null }
  const done = read?.key === key ? read : undefined
  if (done?.problem)
    return { url: undefined, stamp: undefined, loaded: null, problem: done.problem }
  // Ready, kept but let go of since (other files loaded), or unplayable: what played plays on.
  if (done) return { url: good?.url, stamp: good?.stamp, loaded: null, problem: null }
  // Still reading: what played before plays on.
  return {
    url: good?.url,
    stamp: good?.stamp,
    loaded: progress?.key === key ? progress.loaded : 0,
    problem: null,
  }
}
