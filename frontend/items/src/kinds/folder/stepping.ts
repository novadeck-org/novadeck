import type { FolderEntry, Item, ItemId, ItemKind } from "@novadeck/core/items"
import type { Workspace } from "@novadeck/core/types"

import { separatorOf, sorted, type FolderSort } from "./model"

// What a file shown in the pane knows of the folder it is in, so it can step to its neighbours
// and go back to them: which folder item holds it (the file is under its top), and the rules for
// the files it steps through. All of it is pure; ../../file-steps.tsx draws it.

// The kinds of item that point at a file, which a folder's files open as.
export const fileKinds: ReadonlySet<ItemKind> = new Set(["image", "video", "audio", "pdf", "file"])

// The kinds whose viewer leaves ← and → alone, so they step through the folder too. An image's
// pans only while it is zoomed, and says so by taking the key (the steps never hear a key a
// viewer took); a video and a recording seek by them, a PDF turns pages, and a text file's caret,
// scroll and data tree move by them, so none of those steps by key, though each has the tools.
export const arrowKinds: ReadonlySet<ItemKind> = new Set(["image"])

// The folder item a file is in, and the folder of it the file sits in as a path from its top.
export type Home = { readonly folder: Item; readonly within: string }

// The items of the session `id` is in: the very array the workspace holds, so it is the same
// until one of the session's items changes. Empty where no session holds `id`.
const none: readonly Item[] = []
export const sessionOf = (workspace: Workspace, id: ItemId): readonly Item[] => {
  for (const project of workspace.projects)
    for (const each of project.history)
      if (each.state.items.some((candidate) => candidate.id === id)) return each.state.items
  return none
}

// The names a path is made of, as the separator it is written with divides them.
const partsOf = (path: string): string[] =>
  path.split(separatorOf(path)).filter((part) => part !== "")

const sameHolder = (a: Item["holder"], b: Item["holder"]): boolean =>
  "terminalId" in a
    ? "terminalId" in b && a.terminalId === b.terminalId
    : "windowId" in b && a.windowId === b.windowId

// The folder item that holds `file`, among `items`, those of its session: one whose top is a
// folder above the file. One on the file's own holder is preferred, and of those the deepest top,
// as it is the nearest. A file with no folder item above it, as one an agent showed from
// elsewhere, is in none.
export const homeOf = (file: Item, items: readonly Item[]): Home | undefined => {
  if (!fileKinds.has(file.kind) || file.path === null) return undefined
  const directory = partsOf(file.path).slice(0, -1)
  const homes = items.flatMap((folder): Home[] => {
    if (folder.kind !== "folder" || folder.path === null) return []
    const top = partsOf(folder.path)
    if (top.length > directory.length || top.some((part, index) => part !== directory[index]))
      return []
    return [{ folder, within: directory.slice(top.length).join("/") }]
  })
  const own = homes.filter((home) => sameHolder(home.folder.holder, file.holder))
  const nearest = (own.length > 0 ? own : homes).toSorted(
    (a, b) => partsOf(b.folder.path!).length - partsOf(a.folder.path!).length,
  )
  return nearest[0]
}

// The kind of item a folder's file opens as, as the runner's attach makes it: a text file or any
// other is a file. Nothing for a folder.
export const itemKindOf = (entry: FolderEntry): ItemKind | undefined =>
  entry.kind === "folder"
    ? undefined
    : entry.kind === "text" || entry.kind === "other"
      ? "file"
      : entry.kind

// The files stepping goes through: those of the folder's listing that are of the file's own kind,
// in the folder's sort. A folder is never stepped into, a file that may hold secrets is never
// opened by stepping, and a link leaving the folder is never followed.
export const stepsOf = (
  entries: readonly FolderEntry[],
  kind: ItemKind,
  sort: FolderSort,
): readonly FolderEntry[] =>
  sorted(
    entries.filter((entry) => !entry.secret && !entry.link && itemKindOf(entry) === kind),
    sort,
  )

// The files either side of the one named, among those stepping goes through: undefined where it
// isn't among them (not listed yet, or held back), and a side that is undefined where it is the
// first or last.
export const neighboursOf = (
  steps: readonly FolderEntry[],
  name: string,
):
  | { readonly before: FolderEntry | undefined; readonly after: FolderEntry | undefined }
  | undefined => {
  const at = steps.findIndex((entry) => entry.name === name)
  return at < 0 ? undefined : { before: steps[at - 1], after: steps[at + 1] }
}

// The name of the file a path ends in.
export const fileNameOf = (path: string): string => partsOf(path).at(-1) ?? path
