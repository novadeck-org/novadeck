import type { FilePart, FolderEntry } from "@novadeck/core/items"

// How a folder's grid draws the file of a kind: a kind registers a renderer, which the folder
// calls with the entry, to read what it needs of the file through `read`, and gets back a picture
// to show (and, for a video, its length). The folder owns the rest: the queue (a few at a time,
// the nearest to the middle of the view first), stopping a renderer that is no longer wanted, the
// object URL of the picture (made, kept by the file's stamp, revoked once no tile shows it) and
// the length's badge. A kind with none, or a renderer that answers null, shows its icon.

export type FolderEntryKind = FolderEntry["kind"]

// What a renderer is given of the file: its name and size, and `read`, which reads it in parts
// from `offset` as the folder reads any file of it (`companions.part`, with the file's path in
// the folder and the stamp its listing gave): `changed` where it was rewritten meanwhile, or why
// it can't be read.
export type EntryThumbFile = {
  readonly name: string
  readonly size: number
  readonly read: (offset: number, signal: AbortSignal) => Promise<FilePart>
}

// The size of the box the picture is drawn in, in CSS pixels; a picture may be drawn larger for a
// denser screen, and is cut to fit it.
export type EntryThumbBox = { readonly width: number; readonly height: number }

export type EntryThumb = { readonly blob: Blob; readonly duration?: number }

// Draws a file's picture, or answers null where it can't (too large, not what it says it is): the
// folder then shows the kind's icon. It stops at once when `signal` aborts, which it also does
// once a deadline of 15 s has passed (the icon is then shown whatever it does), and is not asked
// again for the file while it is as its stamp names it, whether it drew a picture or not; unless
// one of its reads failed, or was still on its way at the deadline, which says nothing of the file.
export type EntryThumbRenderer = (
  entry: EntryThumbFile,
  box: EntryThumbBox,
  signal: AbortSignal,
) => Promise<EntryThumb | null>

const renderers = new Map<FolderEntryKind, EntryThumbRenderer>()

// Makes `renderer` the one that draws the files of `kind`. Registering again replaces it, and what
// was drawn by the one before stays (kept pictures, and files it had no picture for) until the
// file's stamp changes: tiles already drawn are not drawn again.
export const registerEntryThumb = (kind: FolderEntryKind, renderer: EntryThumbRenderer): void => {
  renderers.set(kind, renderer)
}

// Takes the renderer of `kind` away, as a test that registered one does when it is done.
export const unregisterEntryThumb = (kind: FolderEntryKind): void => {
  renderers.delete(kind)
}

export const entryThumbRenderer = (kind: FolderEntryKind): EntryThumbRenderer | undefined =>
  renderers.get(kind)
