import type { SourceChange, SourceListing, SourceProject } from "@novadeck/core/source"

// The Source panel's rules, apart from how it draws: the tree the project's folders and an
// agent's work grow in, which agents a row names, which row a write lights up, and how long a
// trail lasts.

// What reading a folder gave: its listing, or that it couldn't be read.
export type FolderRead = SourceListing | "failed"

// The folders read so far, by path from the project's root ("" for the root).
export type Listings = ReadonlyMap<string, FolderRead>

// What the demo's agents changed, laid over the listings; a runner has none.
export type Overlay = Pick<SourceProject, "changes" | "writing">

export const noOverlay: Overlay = { changes: {}, writing: {} }

export type SourceNode = {
  // Slash-separated from the project root, with no trailing slash.
  readonly path: string
  readonly name: string
  readonly folder: boolean
  // Itself ignored, or inside an ignored folder.
  readonly ignored: boolean
  // How an agent changed this file; folders have none.
  readonly kind: SourceChange | undefined
  // A file's own writes by agent; a folder's latest write by each agent inside it.
  readonly touched: Readonly<Record<string, number>>
  // The agents writing this file now; a folder's, any file inside.
  readonly writing: readonly string[]
  // A file an agent changed, or a folder with one inside.
  readonly changed: boolean
  // A folder's reading: not yet, read, or it couldn't be. Files have none.
  readonly read: "unread" | "read" | "failed" | undefined
  // The folder holds more than it lists.
  readonly truncated: boolean
  readonly children: readonly SourceNode[]
}

export type SourceRow = {
  readonly node: SourceNode
  readonly depth: number
  readonly open: boolean
}

// A quiet line at the end of an open folder (or of the root), saying what its listing lacks:
// that it couldn't be read, that it holds more, or that it holds nothing.
export type SourceNote = {
  readonly note: "failed" | "truncated" | "empty"
  // The folder it ends.
  readonly path: string
  readonly depth: number
}

export type SourceLine = SourceRow | SourceNote

export const isNote = (line: SourceLine): line is SourceNote => "note" in line

// Folders first, then by name without case or a leading dot, so `.github` sits among the g's.
const sortKey = (name: string): string => name.replace(/^\./, "").toLowerCase()

const byOrder = (a: SourceNode, b: SourceNode): number => {
  if (a.folder !== b.folder) return a.folder ? -1 : 1
  const [left, right] = [sortKey(a.name), sortKey(b.name)]
  if (left !== right) return left < right ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

const latestPerAgent = (nodes: readonly SourceNode[]): Readonly<Record<string, number>> => {
  const latest: Record<string, number> = {}
  for (const node of nodes)
    for (const [handle, at] of Object.entries(node.touched))
      latest[handle] = Math.max(latest[handle] ?? at, at)
  return latest
}

const childOf = (parent: string, name: string): string =>
  parent === "" ? name : `${parent}/${name}`

// The root's tree: each folder's listing, if read, with the paths agents changed joined in (a
// changed file shows in its folder whether or not the listing has it). A folder not read yet
// has only what agents changed inside it.
export const buildTree = (
  listings: Listings,
  { changes, writing: writingBy }: Overlay = noOverlay,
): readonly SourceNode[] => {
  // The names agents changed under each folder: folders for paths with something below.
  const changed = new Map<string, Map<string, boolean>>()
  const note = (parent: string, name: string, folder: boolean): void => {
    const names = changed.get(parent) ?? new Map<string, boolean>()
    names.set(name, (names.get(name) ?? false) || folder)
    changed.set(parent, names)
  }
  for (const path of Object.keys(changes)) {
    const parts = path.split("/")
    parts.forEach((name, index) =>
      note(parts.slice(0, index).join("/"), name, index < parts.length - 1),
    )
  }
  const writing = new Map<string, string[]>()
  for (const [handle, path] of Object.entries(writingBy))
    writing.set(path, [...(writing.get(path) ?? []), handle])

  const make = (path: string, name: string, folder: boolean, hidden: boolean): SourceNode => {
    if (!folder) {
      const change = changes[path]
      return {
        path,
        name,
        folder,
        ignored: hidden,
        kind: change?.kind,
        touched: change?.touched ?? {},
        writing: writing.get(path) ?? [],
        changed: change !== undefined,
        read: undefined,
        truncated: false,
        children: [],
      }
    }
    const inside = childrenOf(path, hidden)
    const listing = listings.get(path)
    return {
      path,
      name,
      folder,
      ignored: hidden,
      kind: undefined,
      touched: latestPerAgent(inside),
      writing: [...new Set(inside.flatMap((child) => child.writing))],
      changed: inside.some((child) => child.changed),
      read: listing === undefined ? "unread" : listing === "failed" ? "failed" : "read",
      truncated: typeof listing === "object" && listing.truncated,
      children: inside,
    }
  }
  const childrenOf = (folder: string, hidden: boolean): readonly SourceNode[] => {
    const listing = listings.get(folder)
    // A name both listed and changed is one node; a path with something below it is a folder.
    const names = new Map<string, { folder: boolean; ignored: boolean }>()
    for (const entry of typeof listing === "object" ? listing.entries : [])
      names.set(entry.name, { folder: entry.folder, ignored: entry.ignored })
    for (const [name, isFolder] of changed.get(folder) ?? []) {
      const known = names.get(name)
      names.set(name, {
        folder: isFolder || (known?.folder ?? false),
        ignored: known?.ignored ?? false,
      })
    }
    return [...names]
      .map(([name, entry]) =>
        make(childOf(folder, name), name, entry.folder, hidden || entry.ignored),
      )
      .toSorted(byOrder)
  }
  return childrenOf("", false)
}

// Whether two readings of a folder say the same, so reading it again changes nothing on screen.
export const sameRead = (a: FolderRead | undefined, b: FolderRead | undefined): boolean => {
  if (a === undefined || b === undefined || typeof a === "string" || typeof b === "string")
    return a === b
  return (
    a.truncated === b.truncated &&
    a.entries.length === b.entries.length &&
    a.entries.every((entry, index) => {
      const other = b.entries[index]!
      return (
        entry.name === other.name &&
        entry.folder === other.folder &&
        entry.ignored === other.ignored
      )
    })
  )
}

// The paths of every folder in the tree.
export const folderPaths = (tree: readonly SourceNode[]): ReadonlySet<string> => {
  const paths = new Set<string>()
  const visit = (node: SourceNode): void => {
    if (!node.folder) return
    paths.add(node.path)
    node.children.forEach(visit)
  }
  tree.forEach(visit)
  return paths
}

// The listings of the folders the tree still has, which are the only ones it uses: those of
// a folder that vanished are dropped, to be read anew if it comes back.
export const keepListings = (listings: Listings, tree: readonly SourceNode[]): Listings => {
  const folders = folderPaths(tree)
  const kept = new Map([...listings].filter(([path]) => path === "" || folders.has(path)))
  return kept.size === listings.size ? listings : kept
}

// The folders that start open: those with a changed file inside, unless ignored.
export const initialOpen = (tree: readonly SourceNode[]): ReadonlySet<string> => {
  const open = new Set<string>()
  const visit = (node: SourceNode): void => {
    if (!node.folder) return
    if (node.changed && !node.ignored) open.add(node.path)
    node.children.forEach(visit)
  }
  tree.forEach(visit)
  return open
}

// The lines on screen, top to bottom: a folder's children follow it while it is open, then a
// note of what its listing lacks; `rootTruncated` ends the root's with one too.
export const visibleLines = (
  tree: readonly SourceNode[],
  open: ReadonlySet<string>,
  rootTruncated = false,
): readonly SourceLine[] => {
  const lines: SourceLine[] = []
  const visit = (node: SourceNode, depth: number): void => {
    const isOpen = expandable(node) && open.has(node.path)
    lines.push({ node, depth, open: isOpen })
    if (!isOpen) return
    node.children.forEach((child) => visit(child, depth + 1))
    if (node.read === "failed") lines.push({ note: "failed", path: node.path, depth: depth + 1 })
    else if (node.truncated) lines.push({ note: "truncated", path: node.path, depth: depth + 1 })
    else if (node.read === "read" && node.children.length === 0)
      lines.push({ note: "empty", path: node.path, depth: depth + 1 })
  }
  tree.forEach((node) => visit(node, 0))
  if (rootTruncated) lines.push({ note: "truncated", path: "", depth: 0 })
  return lines
}

// The rows on screen, without the notes between them.
export const visibleRows = (
  tree: readonly SourceNode[],
  open: ReadonlySet<string>,
): readonly SourceRow[] =>
  visibleLines(tree, open).filter((line): line is SourceRow => !isNote(line))

// Whether a row opens: every folder does, an empty one onto a note saying so, which keeps it read
// again with the rest, so what is written there later shows.
export const expandable = (node: SourceNode): boolean => node.folder

export type FileIcon = "code" | "json" | "text" | "file"

// A plain file's icon, from its name.
export const fileIconOf = (name: string): FileIcon => {
  if (name === ".gitignore" || name.startsWith(".env")) return "text"
  const dot = name.lastIndexOf(".")
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
  if (["ts", "tsx", "js", "html"].includes(extension)) return "code"
  if (extension === "json") return "json"
  if (["md", "txt"].includes(extension)) return "text"
  return "file"
}

export const chipLimit = 2

export type Chips = {
  // The handles to name on the row, at most two.
  readonly shown: readonly string[]
  // How many more there are, folded into a `+N`.
  readonly more: number
  // Everyone, latest write first, for the row's label and the `+N`.
  readonly everyone: readonly string[]
}

// The agents a row names: the lit agents first (the kept ones, else the selected terminal's),
// then any writing this row now, then the most recent writer; past two, the rest fold into a
// count. Only what is kept or selected ranks, never the agent under the pointer, or the chips
// would shuffle beneath it.
export const chipsOf = (
  touched: Readonly<Record<string, number>>,
  writing: readonly string[],
  lit: ReadonlySet<string>,
): Chips => {
  const at = (handle: string): number => touched[handle] ?? 0
  const latest = (a: string, b: string): number => at(b) - at(a) || (a < b ? -1 : 1)
  const everyone = [...new Set([...Object.keys(touched), ...writing])].toSorted(latest)
  const rank = (handle: string): number => (lit.has(handle) ? 0 : writing.includes(handle) ? 1 : 2)
  const ordered = everyone.toSorted((a, b) => rank(a) - rank(b) || latest(a, b))
  return {
    shown: ordered.slice(0, chipLimit),
    more: Math.max(0, ordered.length - chipLimit),
    everyone,
  }
}

// The row's widths in px, from source.css and the type scale: the item recipe's border is 1px a
// side (`--border-width`), `.source-row-select` pads 6px left
// (plus `indent` per depth) and 4px right and spaces its parts by 6px; the twisty is 12px, the
// icon 14px; a cursor or trail mark is 6px; `.source-chips` pads 8px right and spaces by 6px.
// A plain handle chip has no padding of its own, so a chip is as wide as its text: measured in
// the caller's font, else about 0.6em a glyph of the caption size (11px) of the mono font.
export const indent = 12
const rowBorder = 1
const rowPadding = 6
const rowPaddingEnd = 4
const rowGap = 6
const twistyWidth = 12
const iconWidth = 14
const markWidth = 6
const chipsPaddingEnd = 8
const chipGap = 6
const chipGlyph = 6.6
// The body size (13px) is proportional type, about 0.55em a glyph on average: the estimate for a
// name where nothing can measure it (no canvas, as in jsdom, or no font known yet).
const nameGlyph = 7.2

export const estimateNameWidth = (name: string): number => name.length * nameGlyph

// Everything in a row except its name and chips: indentation, twisty, icon, gaps and marks.
const rowFixedWidth = (depth: number, marks: number): number =>
  2 * rowBorder +
  rowPadding +
  indent * depth +
  twistyWidth +
  rowGap +
  iconWidth +
  rowGap +
  marks * (rowGap + markWidth) +
  rowPaddingEnd

export const estimateChipWidth = (text: string): number => text.length * chipGlyph

// A chip's text: `@handle`, and `+N` for the count.
export const handleText = (handle: string): string => `@${handle}`
export const moreText = (more: number): string => `+${more}`

// The chip area for these handles and a `+N` of `more`, each text's width from `widthOf`.
export const chipsWidth = (
  handles: readonly string[],
  more: number,
  widthOf: (text: string) => number = estimateChipWidth,
): number => {
  const widths = handles.map((handle) => widthOf(handleText(handle)))
  if (more > 0) widths.push(widthOf(moreText(more)))
  return (
    chipsPaddingEnd + widths.reduce((sum, width) => sum + width, 0) + chipGap * (widths.length - 1)
  )
}

export type RowFit = {
  // The tree's width, or undefined while it isn't measured (nothing is folded then).
  readonly width: number | undefined
  readonly depth: number
  // The name's full width in px.
  readonly nameWidth: number
  // How many cursors or trails follow the name (see `marksOf`).
  readonly marks: number
  // A chip text's width in px; the estimate where it can't be measured.
  readonly chipWidth?: (text: string) => number
}

// Folds a row's chips by the room it has: two chips stay while the name still reads in full beside
// them, else one chip stays and the rest join the `+N`. Never fewer than one chip.
export const foldChips = (chips: Chips, fit: RowFit): Chips => {
  if (fit.width === undefined || chips.shown.length < 2) return chips
  const room = fit.width - rowFixedWidth(fit.depth, fit.marks) - fit.nameWidth
  if (chipsWidth(chips.shown, chips.more, fit.chipWidth) <= room) return chips
  return { ...chips, shown: chips.shown.slice(0, 1), more: chips.more + chips.shown.length - 1 }
}

// The paths where an agent wrote since `before`: a later time than it had, or a new file.
export const writtenPaths = (
  before: SourceProject["changes"],
  after: SourceProject["changes"],
): readonly string[] =>
  Object.entries(after)
    .filter(([path, change]) =>
      Object.entries(change.touched).some(
        ([handle, at]) => at > (before[path]?.touched[handle] ?? Number.NEGATIVE_INFINITY),
      ),
    )
    .map(([path]) => path)

// The row showing a path: the path itself, or while a folder above it is closed, the
// outermost closed one.
export const rowShowing = (path: string, open: ReadonlySet<string>): string => {
  const parts = path.split("/")
  for (let depth = 1; depth < parts.length; depth++) {
    const folder = parts.slice(0, depth).join("/")
    if (!open.has(folder)) return folder
  }
  return path
}

// How a file's trail fades: from this opacity, by this much every `trailTimeMs`, gone below
// `trailGone`. The panel's CSS keyframes (source.css) follow the same curve.
export const trailStart = 0.7
export const trailTimeMs = 150_000
export const trailGone = 0.04
export const trailLifeMs = trailTimeMs * Math.log(trailStart / trailGone)

export const trailOpacity = (ageMs: number): number =>
  trailStart * Math.exp(-Math.max(0, ageMs) / trailTimeMs)

// The time of a node's latest write, or 0 for none.
export const latestWrite = (node: SourceNode): number => Math.max(0, ...Object.values(node.touched))

// How many marks follow a file's name: a cursor for each agent writing it now, else one slot for
// its trail. The slot is kept whatever the trail's age, so the count never depends on the clock:
// an aged-out trail only turns invisible (see `Trail`), keeping its room.
export const marksOf = (node: SourceNode): number =>
  node.folder ? 0 : node.writing.length > 0 ? node.writing.length : latestWrite(node) > 0 ? 1 : 0
