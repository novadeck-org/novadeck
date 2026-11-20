import { bytesText } from "@novadeck/core/command-text"
import type { FilePart, FolderEntry, Item } from "@novadeck/core/items"
import {
  AudioLines,
  Box,
  File,
  FileText,
  FileType,
  Film,
  Folder,
  Image as ImageIcon,
  Link2,
  Lock,
  Play,
  type LucideIcon,
  type LucideProps,
} from "lucide-react"
import { createElement, useEffect, useRef, useState } from "react"

import { entryThumbRenderer } from "./entry-thumbs"
import { countText, durationText, extensionOf, intoFolder, kindText, modifiedText } from "./model"
import { createQueue, hasNoThumb, holdThumb, keptThumb, loadThumb, type Thumb } from "./thumbs"

// Three pictures are read at a time for the grids on screen, the nearest to the middle first.
const queue = createQueue(3)

// A file of the listed folder read in parts, by its path from the item's top, its stamp and the
// offset: the item store's, bound to this item. Undefined where the backend can't.
export type Reader = (path: string, stamp: string, offset: number) => Promise<FilePart>

export const iconOf = (entry: FolderEntry): LucideIcon =>
  entry.link
    ? Link2
    : entry.secret && entry.kind !== "folder"
      ? Lock
      : (
          {
            folder: Folder,
            image: ImageIcon,
            video: Film,
            audio: AudioLines,
            pdf: FileType,
            model: Box,
            text: FileText,
            other: File,
          } as const
        )[entry.kind]

// An entry's icon.
export const EntryIcon = ({
  entry,
  ...props
}: { readonly entry: FolderEntry } & Omit<LucideProps, "ref">): React.JSX.Element =>
  createElement(iconOf(entry), { "aria-hidden": true, ...props })

// Why an entry isn't opened from here, as its tooltip says it.
export const heldText = (entry: FolderEntry): string | undefined =>
  entry.link
    ? `${entry.name} is a link that leads out of this folder, so Novadeck doesn't follow it.`
    : entry.secret
      ? `${entry.name} may hold secrets, so Novadeck doesn't open it from here.`
      : undefined

// Whether an entry has a picture to draw: what its kind registered draws it (see ./entry-thumbs),
// unless it is held back, or has no stamp to be read by.
export const hasPicture = (entry: FolderEntry): boolean =>
  !entry.secret && !entry.link && entry.stamp !== "" && entryThumbRenderer(entry.kind) !== undefined

// How far an element is from the middle of the grid it is in, as the queue measures nearness.
const awayFromMiddle = (element: HTMLElement | null): number => {
  const scroll = element?.closest(".folder-scroll")
  if (!element || !scroll) return 0
  const own = element.getBoundingClientRect()
  const box = scroll.getBoundingClientRect()
  return Math.abs(own.top + own.height / 2 - (box.top + box.height / 2))
}

// An entry's picture, read once the tile is near the view and its turn comes; kept pictures
// come at once. A file that changed keeps its old picture in view until the new one is read.
const useThumb = (
  entry: FolderEntry,
  { itemId, within, reader }: { itemId: Item["id"]; within: string; reader: Reader | undefined },
  element: React.RefObject<HTMLElement | null>,
): Thumb | undefined => {
  const path = intoFolder(within, entry.name)
  const kind = reader && hasPicture(entry) ? entry.kind : undefined
  const key = `${itemId}:${path}:${entry.stamp}`
  const [thumb, setThumb] = useState<Thumb | undefined>(() => (kind ? keptThumb(key) : undefined))
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined")
  useEffect(() => {
    const own = element.current
    if (!own || typeof IntersectionObserver === "undefined") return
    const watching = new IntersectionObserver(
      (seen) => setNear(seen.some((each) => each.isIntersecting)),
      { rootMargin: "240px" },
    )
    watching.observe(own)
    return () => watching.disconnect()
  }, [element])
  useEffect(() => {
    if (!kind || !reader) return
    if (keptThumb(key) || hasNoThumb(key) || !near) return
    return queue.want(
      () => awayFromMiddle(element.current),
      async (signal) => {
        const made = await loadThumb({
          key,
          kind,
          name: entry.name,
          size: entry.size,
          // A part read can't be called off: a stopped renderer asks for no more, and the one
          // on its way is dropped when it comes.
          read: (offset, _stop) => reader(path, entry.stamp, offset),
          signal,
        })
        if (made && !signal.aborted) setThumb(made)
      },
    )
  }, [kind, key, near, reader, path, entry.name, entry.size, entry.stamp, element])
  const picture = kind ? (keptThumb(key) ?? thumb) : undefined
  const url = picture?.url
  // Shown, a picture isn't revoked when the cache lets go of it.
  useEffect(() => (url === undefined ? undefined : holdThumb(url)), [url])
  return picture
}

export type EntryProps = {
  readonly entry: FolderEntry
  readonly itemId: Item["id"]
  readonly within: string
  readonly reader: Reader | undefined
  readonly selected: boolean
  // How many writes it has had lately while it is being written now, else undefined; and
  // whether it is new since the folder was opened.
  readonly writing: number | undefined
  readonly fresh: boolean
  readonly now: number
  readonly onSelect: () => void
  // Opens it; as text (its source, where its kind has one) when asked, as Alt+double-click does.
  readonly onOpen: (asText: boolean) => void
  // The person asked for its menu (right-click, the menu key or Shift+F10).
  readonly onMenu: () => void
}

// What a name is followed by: the cursor of a file being written, and the mark of one that came
// since the folder was opened.
const Marks = ({
  writing,
  fresh,
}: {
  writing: number | undefined
  fresh: boolean
}): React.JSX.Element => (
  <>
    {writing !== undefined && <span className="files-cursor" aria-hidden="true" />}
    {fresh && <span className="folder-new" role="img" aria-label="New" />}
  </>
)

// The keys a tile or a row answers beyond a click: Enter opens it.
const openOnEnter = (open: (asText: boolean) => void) => (event: React.KeyboardEvent) => {
  if (event.key !== "Enter") return
  event.preventDefault()
  // Held down, it opens once.
  if (!event.repeat) open(false)
}

// The Files panel's two names for one pulse, so a write that lands while the last still plays
// plays it again.
const pulseOf = (writing: number | undefined): "a" | "b" | undefined =>
  writing === undefined ? undefined : writing % 2 === 1 ? "a" : "b"

const marks = (entry: FolderEntry): Record<string, string | true | undefined> => ({
  "data-secret": entry.secret || undefined,
  "data-link": entry.link || undefined,
  "data-folder": entry.kind === "folder" || undefined,
  // What the view finds its entry by from a key pressed on it.
  "data-name": entry.name,
})

// An entry in the grid: its picture (or its kind's icon), then its name and what it is.
export const Tile = ({
  entry,
  itemId,
  within,
  reader,
  selected,
  writing,
  fresh,
  onSelect,
  onOpen,
  onMenu,
  now,
}: EntryProps): React.JSX.Element => {
  const ref = useRef<HTMLButtonElement>(null)
  // The picture the page failed to draw, by its URL.
  const [broken, setBroken] = useState<string>()
  const thumb = useThumb(entry, { itemId, within, reader }, ref)
  const held = heldText(entry)
  const meta = held
    ? entry.link
      ? "Link"
      : "May hold secrets"
    : entry.kind === "folder"
      ? entry.children === null
        ? "Folder"
        : countText(entry.children)
      : `${bytesText(entry.size)} · ${modifiedText(entry.modifiedAt, now)}`
  return (
    <button
      ref={ref}
      type="button"
      className="folder-tile"
      data-selected={selected || undefined}
      data-pulse={pulseOf(writing)}
      data-kind={entry.kind}
      {...marks(entry)}
      title={held}
      onClick={onSelect}
      onDoubleClick={(event) => onOpen(event.altKey)}
      onContextMenu={onMenu}
      onKeyDown={openOnEnter(onOpen)}
    >
      <span className="folder-thumb">
        {thumb && thumb.url !== broken ? (
          // One the page can't draw after all shows the icon.
          <img src={thumb.url} alt="" draggable={false} onError={() => setBroken(thumb.url)} />
        ) : (
          <>
            <EntryIcon entry={entry} strokeWidth={1.5} />
            {entry.kind !== "folder" && !held && (
              <span className="folder-ext">{extensionOf(entry.name)}</span>
            )}
          </>
        )}
        {thumb?.duration !== undefined && thumb.url !== broken && (
          <span className="folder-badge">
            <Play aria-hidden />
            {durationText(thumb.duration)}
          </span>
        )}
      </span>
      <span className="folder-name">
        <span className="folder-name-text">{entry.name}</span>
        <Marks writing={writing} fresh={fresh} />
      </span>
      <span className="folder-meta">{meta}</span>
    </button>
  )
}

// An entry in the list: Name, Modified, Size and Kind.
export const Row = ({
  entry,
  selected,
  writing,
  fresh,
  now,
  onSelect,
  onOpen,
  onMenu,
}: EntryProps): React.JSX.Element => {
  const held = heldText(entry)
  return (
    <tr
      className="folder-row"
      tabIndex={0}
      aria-selected={selected}
      data-selected={selected || undefined}
      data-pulse={pulseOf(writing)}
      {...marks(entry)}
      title={held}
      onClick={onSelect}
      onDoubleClick={(event) => onOpen(event.altKey)}
      onContextMenu={onMenu}
      onKeyDown={openOnEnter(onOpen)}
    >
      <td className="folder-col-name">
        <EntryIcon entry={entry} size={14} strokeWidth={1.5} />
        <span className="folder-name-text">{entry.name}</span>
        <Marks writing={writing} fresh={fresh} />
      </td>
      <td className="folder-col-modified">{modifiedText(entry.modifiedAt, now)}</td>
      <td className="folder-col-size">
        {entry.kind === "folder"
          ? entry.children === null
            ? ""
            : countText(entry.children)
          : bytesText(entry.size)}
      </td>
      <td className="folder-col-kind">{kindText(entry)}</td>
    </tr>
  )
}
