import type { FolderEntry } from "@novadeck/core/items"

import type { FolderSort } from "./view-state"

// What a folder item shows is the runner's listing; how it is looked at (./view-state), and the
// pure rules for reading it as it changes, are here: sorting, the crumbs, what waits while the
// pointer is in the grid, and which files are being written now.

export {
  countText,
  defaultFolderView,
  type FolderLayout,
  type FolderSort,
  type FolderView,
} from "./view-state"

export const sortNames: Record<FolderSort, string> = {
  newest: "newest first",
  name: "name",
  size: "size, largest first",
}

// The sort after this one, as the sort tool cycles them.
export const nextSort = (sort: FolderSort): FolderSort =>
  sort === "newest" ? "name" : sort === "name" ? "size" : "newest"

const byName = (a: FolderEntry, b: FolderEntry): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) ||
  (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

// The entries in a sort's order. By name or size, folders come first; by time, all are mixed,
// newest on top, so what an agent just wrote is the first thing.
export const sorted = (entries: readonly FolderEntry[], sort: FolderSort): FolderEntry[] =>
  entries.toSorted((a, b) => {
    if (sort === "newest") return b.modifiedAt - a.modifiedAt || byName(a, b)
    const folders = Number(b.kind === "folder") - Number(a.kind === "folder")
    if (folders !== 0) return folders
    return sort === "name" ? byName(a, b) : b.size - a.size || byName(a, b)
  })

// The separator a path is written with.
export const separatorOf = (path: string): "/" | "\\" =>
  path.includes("\\") && !path.includes("/") ? "\\" : "/"

// A file of the listed folder by its absolute path, `directory` being that folder's own.
export const absoluteOf = (directory: string, name: string): string => {
  const separator = separatorOf(directory)
  return directory.endsWith(separator) ? `${directory}${name}` : `${directory}${separator}${name}`
}

// A folder inside the one `within` names, from the top.
export const intoFolder = (within: string, name: string): string =>
  within === "" ? name : `${within}/${name}`

// The folder above the one `within` names, from the top; the top has none.
export const parentOf = (within: string): string | null =>
  within === "" ? null : within.split("/").slice(0, -1).join("/")

const nameOf = (path: string): string => {
  const parts = path.split(/[\\/]/).filter((part) => part !== "")
  return parts.at(-1) ?? path
}

// The crumbs of the folder `within` names: they start at the top, the folder that was opened;
// what is above it is only text (`above`), never a way up. Each crumb names the folder it goes to.
export const crumbsOf = (
  top: string,
  within: string,
): {
  readonly above: string
  readonly crumbs: readonly { readonly name: string; readonly within: string }[]
} => {
  const separator = separatorOf(top)
  const trimmed = top.length > 1 ? top.replace(/[\\/]+$/, "") : top
  const name = nameOf(trimmed)
  const above = trimmed.slice(0, trimmed.length - name.length)
  const names = within === "" ? [] : within.split("/")
  return {
    above: above === separator ? "" : above,
    crumbs: [
      { name, within: "" },
      ...names.map((each, index) => ({ name: each, within: names.slice(0, index + 1).join("/") })),
    ],
  }
}

// Files that came since the person was last in the grid wait in a pill while the pointer is in
// it, so nothing moves under it. `seen` is the names the grid has drawn (null before its first
// listing, which is drawn whole); `held` the new ones kept back; `fresh` the ones drawn since
// the first listing, which carry the new mark.
export type Arrivals = {
  readonly seen: ReadonlySet<string> | null
  readonly held: ReadonlySet<string>
  readonly fresh: ReadonlySet<string>
}

export const noArrivals: Arrivals = { seen: null, held: new Set(), fresh: new Set() }

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((name) => b.has(name))

// The state once a listing of `names` came, `holding` while the pointer is in the grid. The same
// state back where nothing changed.
export const arrive = (state: Arrivals, names: readonly string[], holding: boolean): Arrivals => {
  if (state.seen === null) return { seen: new Set(names), held: new Set(), fresh: new Set() }
  const present = new Set(names)
  const fresh = names.filter((name) => !state.seen!.has(name))
  const waiting = new Set([...state.held, ...fresh].filter((name) => present.has(name)))
  const held = holding ? waiting : new Set<string>()
  const seen = new Set(
    [...state.seen, ...(holding ? [] : waiting)].filter((name) => present.has(name)),
  )
  const marked = new Set(
    [...state.fresh, ...(holding ? [] : waiting)].filter((name) => present.has(name)),
  )
  return sameSet(seen, state.seen) && sameSet(held, state.held) && sameSet(marked, state.fresh)
    ? state
    : { seen, held, fresh: marked }
}

// How long a file shows as being written after its size last changed.
export const writingMs = 2500

// The files whose size changed between two listings, which are being written.
export const grown = (
  before: readonly FolderEntry[],
  after: readonly FolderEntry[],
): readonly string[] => {
  const sizes = new Map(before.map((entry) => [entry.name, entry.size]))
  return after
    .filter((entry) => entry.kind !== "folder" && sizes.has(entry.name))
    .filter((entry) => sizes.get(entry.name) !== entry.size)
    .map((entry) => entry.name)
}

// A duration as a player writes it: 0:07, 1:05, 1:02:03.
export const durationText = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = String(whole % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`
}

// When a file changed, as a list says it: how long ago while it is recent, else the date.
export const modifiedText = (at: number, now: number): string => {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

// What kind of thing an entry is, in a word.
export const kindText = (entry: FolderEntry): string =>
  entry.link
    ? "Link"
    : (
        {
          folder: "Folder",
          image: "Image",
          video: "Video",
          audio: "Audio",
          pdf: "PDF",
          model: "3D model",
          text: "Text",
          other: "File",
        } as const
      )[entry.kind]

// The extension shown on a tile with no picture, in capitals.
export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".")
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1, dot + 6).toUpperCase() : ""
}

// The largest video that is read whole to draw its first frame and learn its length; a larger one
// shows the kind's icon.
export const videoFrameBytes = 24 * 1024 * 1024
