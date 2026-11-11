import type { ChangedFile, ChangeLayer } from "@novadeck/core/items"

// The files the selected layers changed, as the tree the list view draws: one row for each
// path, its counts those of the layers added up (a line two layers changed counts in each),
// folders above them.

/** A file as the selected layers changed it together. */
export type TreeFile = Omit<ChangedFile, "status"> & {
  readonly status: ChangedFile["status"]
  /** The name after the last slash, and the folder before it. */
  readonly name: string
  readonly dir: string
  /** The selected layers that changed it, newest first. */
  readonly layers: readonly string[]
}

export type TreeRow =
  | {
      readonly kind: "folder"
      readonly path: string
      readonly name: string
      readonly depth: number
    }
  | { readonly kind: "file"; readonly file: TreeFile; readonly depth: number }

const split = (path: string): { name: string; dir: string } => {
  const at = path.lastIndexOf("/")
  return { name: path.slice(at + 1), dir: at < 0 ? "" : path.slice(0, at) }
}

/** The files the selected layers changed, by path. */
export const filesOf = (
  layers: readonly ChangeLayer[],
  selected: ReadonlySet<string>,
): TreeFile[] => {
  const found = new Map<string, { file: ChangedFile; layer: string }[]>()
  // Oldest first, so the first entry of a path is where it began.
  for (const layer of layers.toReversed()) {
    if (!selected.has(layer.id)) continue
    for (const file of layer.files) {
      const entries = found.get(file.path) ?? []
      entries.push({ file, layer: layer.id })
      found.set(file.path, entries)
    }
  }
  return [...found].map(([path, entries]) => {
    const oldest = entries[0]!.file
    const newest = entries.at(-1)!.file
    const status =
      newest.status === "deleted"
        ? "deleted"
        : oldest.status === "added"
          ? "added"
          : newest.status === "renamed"
            ? "renamed"
            : "modified"
    return {
      path,
      oldPath: oldest.oldPath,
      status,
      added: entries.reduce((sum, { file }) => sum + file.added, 0),
      removed: entries.reduce((sum, { file }) => sum + file.removed, 0),
      reindented: entries.reduce((sum, { file }) => sum + file.reindented, 0),
      binary: entries.some(({ file }) => file.binary),
      secret: entries.some(({ file }) => file.secret),
      ...split(path),
      layers: entries.map(({ layer }) => layer).toReversed(),
    }
  })
}

type Folder = { readonly folders: Map<string, Folder>; readonly files: TreeFile[] }

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true })

/** The tree of files: a folder's folders before its files, each in name order. */
export const rowsOf = (files: readonly TreeFile[]): TreeRow[] => {
  const root: Folder = { folders: new Map(), files: [] }
  for (const file of files) {
    let folder = root
    for (const part of file.dir === "" ? [] : file.dir.split("/")) {
      let next = folder.folders.get(part)
      if (!next) {
        next = { folders: new Map(), files: [] }
        folder.folders.set(part, next)
      }
      folder = next
    }
    folder.files.push(file)
  }
  const rows: TreeRow[] = []
  const walk = (folder: Folder, path: string, depth: number) => {
    for (const name of [...folder.folders.keys()].toSorted(byName)) {
      const here = path === "" ? name : `${path}/${name}`
      rows.push({ kind: "folder", path: here, name, depth })
      walk(folder.folders.get(name)!, here, depth + 1)
    }
    for (const file of folder.files.toSorted((a, b) => byName(a.name, b.name)))
      rows.push({ kind: "file", file, depth })
  }
  walk(root, "", 0)
  return rows
}

/**
 * The files of a range as git lists them, as tree files: each by the selected layers that list
 * it (by the name it has or had), so a commit that touches other files does not make it read
 * again; all of them where none does (a layer's list may be cut).
 */
export const filesOfRange = (
  files: readonly ChangedFile[],
  all: readonly ChangeLayer[],
  selected: readonly string[],
): TreeFile[] =>
  files.map((file) => {
    const own = selected.filter((id) =>
      all.some(
        (layer) =>
          layer.id === id &&
          layer.files.some(
            (each) =>
              each.path === file.path || (file.oldPath !== null && each.path === file.oldPath),
          ),
      ),
    )
    return { ...file, ...split(file.path), layers: own.length > 0 ? own : selected }
  })
