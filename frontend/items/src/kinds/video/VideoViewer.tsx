import type { UnavailableReason, VideoContent } from "@novadeck/core/items"
import { Progress } from "@novadeck/toolkit/Progress"
import { Film } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Unavailable, type ArtifactBodyProps } from "../../ArtifactViewer"
import { usePaneNote } from "../../pane-row"
import { blobs } from "./blobs"
import { factsText, formatName, loadingText, bytesText } from "./format"
import { loadVideo } from "./load"
import { VideoPlayer } from "./VideoPlayer"

// Where a video's source stands: its URL once its bytes are in, kept while a newer file's are
// read, so the old one plays on until the new one is ready; how far the read has got, if it is
// reading; or why there is nothing to play.
type Source = {
  readonly url: string | undefined
  readonly loaded: number | null
  readonly problem: UnavailableReason | "failed" | "here" | null
}

// What the last read of the video came to, and for which file (`key`: the item and its stamp),
// and how far the read of a file has got.
type Read = {
  readonly key: string
  readonly url: string | undefined
  readonly problem: Source["problem"]
}

// Loads the video's bytes while it shows, for the stamp it is at; each new stamp reads it
// afresh, and a pane that comes back finds the last few already loaded.
const useSource = ({
  item,
  content,
  stamp,
  itemStore,
  target,
}: ArtifactBodyProps<"video">): Source => {
  const [read, setRead] = useState<Read>()
  const [progress, setProgress] = useState<{ key: string; loaded: number }>()
  const { videoPart } = itemStore
  const { size, mime } = content
  const reveal = item.path ?? undefined
  const id = item.id
  const key = `${id}:${stamp}`
  // Where it's read for, which a read in progress takes as it is when it asks.
  const where = useRef(target)
  useEffect(() => {
    where.current = target
  })
  useEffect(() => {
    if (!videoPart || blobs.get(key)) return
    const stop = new AbortController()
    void loadVideo({
      read: async (offset) => videoPart(where.current, id, { stamp, offset, reveal }),
      size,
      mime,
      signal: stop.signal,
      progress: (loaded) => setProgress({ key, loaded }),
    }).then((result) => {
      if (stop.signal.aborted || result.state === "stopped") return
      // A file rewritten while it was read ends the read: the content that follows has a
      // stamp of its own, and reads it again.
      if (result.state === "changed") return setProgress({ key, loaded: 0 })
      if (result.state === "ready")
        return setRead({ key, url: blobs.keep(key, result.blob), problem: null })
      setRead({
        key,
        url: undefined,
        problem: result.state === "failed" ? "failed" : result.reason,
      })
    })
    return () => stop.abort()
  }, [id, key, stamp, size, mime, reveal, videoPart])
  if (!videoPart) return { url: undefined, loaded: null, problem: "here" }
  const kept = blobs.get(key)
  if (kept) return { url: kept, loaded: null, problem: null }
  if (read?.key === key) return { url: read.url, loaded: null, problem: read.problem }
  // Still reading: what played before plays on.
  return {
    url: read?.url,
    loaded: progress?.key === key ? progress.loaded : 0,
    problem: null,
  }
}

// A video of a pane, played with its own bar once its bytes are in, and its progress till then.
export const VideoViewer = (props: ArtifactBodyProps<"video">): React.JSX.Element => {
  const { item, content, itemStore } = props
  const source = useSource(props)
  usePaneNote([factsText(content.mime, content.size)])
  // The URL of the bytes the browser couldn't play, so a newer file's are tried afresh.
  const [broken, setBroken] = useState<string>()
  const { url, loaded, problem } = source
  // Held while it plays, so other videos loading never revoke it under the player.
  useEffect(() => (url === undefined ? undefined : blobs.hold(url)), [url])
  if (problem === "here" || problem === "failed" || (url !== undefined && broken === url))
    return (
      <div className="artifact-status" role="alert">
        {problem === "failed"
          ? `${item.name} couldn't be loaded.`
          : `${item.name} can't be played here.`}
      </div>
    )
  if (problem)
    return (
      <Unavailable
        item={item}
        reason={problem}
        size={content.size}
        onReveal={() => itemStore.reveal(item.id, item.path)}
      />
    )
  return (
    <div className="video-viewer" aria-busy={url === undefined}>
      {url !== undefined && (
        <VideoPlayer
          id={item.id}
          src={url}
          name={item.name}
          shown={content.shown}
          at={content.at}
          onBroken={() => setBroken(url)}
        />
      )}
      {loaded !== null && (
        <div className="video-loading" data-over={url !== undefined || undefined} role="status">
          <p>{loadingText(loaded, content.size)}</p>
          <Progress label="Loading the video" value={loaded} max={content.size} />
        </div>
      )}
    </div>
  )
}

// The video's format and size, for its peek: its bytes are never read for it.
export const VideoThumb = ({ content }: { content: VideoContent }): React.JSX.Element => (
  <span className="peek-video">
    <Film size={18} strokeWidth={1.5} aria-hidden />
    <span>{formatName(content.mime)}</span>
    <span>{bytesText(content.size)}</span>
  </span>
)
