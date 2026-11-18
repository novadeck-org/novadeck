import type { UnavailableReason } from "@novadeck/core/items"
import { useEffect, useRef, useState } from "react"

import type { ArtifactBodyProps } from "../../ArtifactViewer"
import { useRevealed } from "../../store/use-item-store"
import { blobs } from "./blobs"
import { loadVideo } from "./load"
import { playable } from "./playable"

// What a video's or a recording's body is given.
export type MediaProps = Pick<
  ArtifactBodyProps<"video" | "audio">,
  "item" | "content" | "stamp" | "itemStore" | "target"
>

// Where a media file's source stands: its URL once its bytes are in, kept while a newer file's are
// read, so the old one plays on until the new one is ready; how far the read has got, if it is
// reading; or why there is nothing to play.
export type Source = {
  readonly url: string | undefined
  readonly loaded: number | null
  readonly problem: UnavailableReason | "failed" | "here" | null
}

// What the last read of the file came to, and for which file (`key`: the item and its stamp),
// and how far the read of a file has got.
type Read = {
  readonly key: string
  readonly url: string | undefined
  readonly problem: Source["problem"]
}

// Loads the bytes of a video or a recording while it shows, for the stamp it is at; each new stamp reads it
// afresh, and a pane that comes back finds the last few already loaded. Bytes the browser
// can't play, as a file caught while it was rewritten in place, never replace what
// played: it plays on until the next render. `element` is what the bytes are tried on.
export const useSource = (
  { item, content, stamp, itemStore, target }: MediaProps,
  element: "video" | "audio",
): Source => {
  const [read, setRead] = useState<Read>()
  const [progress, setProgress] = useState<{ key: string; loaded: number }>()
  const { videoPart } = itemStore
  const { size, mime } = content
  // Only the person's yes to a file that may hold secrets reads it.
  const reveal = useRevealed(itemStore, item)
  const id = item.id
  const key = `${id}:${stamp}`
  // Where it's read for, which a read in progress takes as it is when it asks.
  const where = useRef(target)
  useEffect(() => {
    where.current = target
  })
  useEffect(() => {
    if (!videoPart || blobs.get(id, stamp)) return
    const stop = new AbortController()
    void loadVideo({
      read: async (offset) => videoPart(where.current, id, { stamp, offset, reveal }),
      size,
      mime,
      signal: stop.signal,
      progress: (loaded) => setProgress({ key, loaded }),
    }).then(async (result) => {
      if (stop.signal.aborted || result.state === "stopped") return
      // A file rewritten while it was read ends the read: the content that follows has a
      // stamp of its own, and reads it again.
      if (result.state === "changed") return setProgress({ key, loaded: 0 })
      if (result.state === "ready") {
        const plays = await playable(result.blob, element)
        if (stop.signal.aborted) return
        if (plays) return setRead({ key, url: blobs.keep(id, stamp, result.blob), problem: null })
        return setRead((was) =>
          was?.url !== undefined && was.problem === null
            ? { key, url: was.url, problem: null }
            : { key, url: undefined, problem: "here" },
        )
      }
      setRead({
        key,
        url: undefined,
        problem: result.state === "failed" ? "failed" : result.reason,
      })
    })
    return () => stop.abort()
  }, [id, key, stamp, size, mime, reveal, videoPart, element])
  if (!videoPart) return { url: undefined, loaded: null, problem: "here" }
  const kept = blobs.get(id, stamp)
  if (kept) return { url: kept, loaded: null, problem: null }
  if (read?.key === key) return { url: read.url, loaded: null, problem: read.problem }
  // Still reading: what played before plays on.
  return {
    url: read?.url,
    loaded: progress?.key === key ? progress.loaded : 0,
    problem: null,
  }
}
