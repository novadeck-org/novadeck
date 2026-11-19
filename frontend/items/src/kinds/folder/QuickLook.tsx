import type { FolderEntry, Item } from "@novadeck/core/items"
import { useEffect, useRef, useState } from "react"

import { EntryIcon, hasPicture, heldText, type Reader } from "./Entries"
import { durationText, kindText, modifiedText, sizeShort } from "./model"
import { hasNoThumb, holdThumb, keptThumb, loadThumb, type Thumb } from "./thumbs"

// The box a quick look's picture is drawn in: larger than a tile's, as far as a kind's renderer
// takes it (an image is itself; a video's frame is drawn this wide).
const lookBox = { width: 960, height: 540 }

// The picture of an entry for the quick look, read as a tile's is (through the same reader, kept
// by the file's stamp, so one the grid drew shows at once), or undefined while it is read and for
// an entry with none. A video's is its own, drawn larger than its tile's.
const useLook = (
  entry: FolderEntry,
  path: string,
  itemId: Item["id"],
  reader: Reader | undefined,
): Thumb | undefined => {
  const kind = reader && hasPicture(entry) ? entry.kind : undefined
  const base = `${itemId}:${path}:${entry.stamp}`
  const key = entry.kind === "video" ? `${base}:look` : base
  const [made, setMade] = useState<{ readonly key: string; readonly thumb: Thumb }>()
  useEffect(() => {
    if (!kind || !reader || keptThumb(key) || hasNoThumb(key)) return
    const stop = new AbortController()
    void loadThumb({
      key,
      kind,
      name: entry.name,
      size: entry.size,
      read: (offset) => reader(path, entry.stamp, offset),
      signal: stop.signal,
      box: lookBox,
    }).then((thumb) => {
      if (thumb && !stop.signal.aborted) setMade({ key, thumb })
    })
    return () => stop.abort()
  }, [kind, key, reader, path, entry.name, entry.size, entry.stamp])
  const thumb = kind ? (keptThumb(key) ?? (made?.key === key ? made.thumb : undefined)) : undefined
  const url = thumb?.url
  // Shown, a picture isn't revoked when the cache lets go of it.
  useEffect(() => (url === undefined ? undefined : holdThumb(url)), [url])
  return thumb
}

// A quick look at a file of the folder, floating over the pane on the peek's surface: its picture
// where it has one (an image, a video's first frame with its length, or what another kind
// registered), else its icon and what the listing says of it. It opens no tab, and keeps focus
// while it is up: ← and → step, Enter opens the file, Space and Escape close it.
export const QuickLook = ({
  entry,
  path,
  itemId,
  reader,
  now,
  onStep,
  onOpen,
  onClose,
}: {
  readonly entry: FolderEntry
  // The entry's path from the folder's top.
  readonly path: string
  readonly itemId: Item["id"]
  readonly reader: Reader | undefined
  readonly now: number
  readonly onStep: (by: -1 | 1) => void
  readonly onOpen: () => void
  readonly onClose: () => void
}): React.JSX.Element => {
  const holder = useRef<HTMLDivElement>(null)
  useEffect(() => holder.current?.focus({ preventScroll: true }), [])
  const thumb = useLook(entry, path, itemId, reader)
  // The picture the page failed to draw, by its URL, and what it measured of the one it drew.
  const [broken, setBroken] = useState<string>()
  const [measured, setMeasured] = useState<{ readonly url: string; readonly text: string }>()
  const drawn = thumb && thumb.url !== broken ? thumb : undefined
  const held = heldText(entry)
  const dimensions =
    drawn && measured?.url === drawn.url
      ? measured.text
      : drawn?.duration !== undefined
        ? durationText(drawn.duration)
        : undefined
  return (
    <div
      ref={holder}
      className="floating peek folder-look"
      data-state="open"
      role="dialog"
      aria-label={`Quick look at ${entry.name}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        const handled =
          event.key === "ArrowLeft"
            ? () => onStep(-1)
            : event.key === "ArrowRight"
              ? () => onStep(1)
              : event.key === "Enter"
                ? onOpen
                : event.key === " " || event.key === "Escape"
                  ? onClose
                  : undefined
        if (!handled) return
        event.preventDefault()
        event.stopPropagation()
        handled()
      }}
    >
      <div className="folder-look-picture" data-kind={entry.kind}>
        {drawn ? (
          <img
            src={drawn.url}
            alt=""
            draggable={false}
            onError={() => setBroken(drawn.url)}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget
              // A video's frame is drawn smaller than the video: only an image knows its size.
              if (entry.kind === "image" && width > 0)
                setMeasured({ url: drawn.url, text: `${width} × ${height}` })
            }}
          />
        ) : (
          <div className="folder-look-icon">
            <EntryIcon entry={entry} size={44} strokeWidth={1.25} />
            <b>{held ? (entry.link ? "Link" : "May hold secrets") : kindText(entry)}</b>
            <span>{`Modified ${modifiedText(entry.modifiedAt, now)}`}</span>
          </div>
        )}
      </div>
      <div className="folder-look-foot">
        <span className="folder-look-name">
          <EntryIcon entry={entry} size={14} strokeWidth={1.75} />
          {entry.name}
        </span>
        <span className="folder-look-meta">
          {[dimensions, sizeShort(entry.size)].filter(Boolean).join(" · ")}
        </span>
        <span className="folder-look-keys">
          <kbd>←</kbd>
          <kbd>→</kbd> step · <kbd>Enter</kbd> open in a tab · <kbd>Space</kbd> close
        </span>
      </div>
    </div>
  )
}
