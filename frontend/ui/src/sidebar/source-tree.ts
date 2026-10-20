import type { SourceChange, SourceProject } from "@novadeck/core/source"

// The Source panel's rules, apart from how it draws: the tree an agent's work grows in, which
// agents a row names, which row a write lights up, and how long a trail lasts.

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
  readonly children: readonly SourceNode[]
}

export type SourceRow = {
  readonly node: SourceNode
  readonly depth: number
  readonly open: boolean
}

const parentOf = (path: string): string => {
  const slash = path.lastIndexOf("/")
  return slash < 0 ? "" : path.slice(0, slash)
}

const trimmed = (path: string): string => (path.endsWith("/") ? path.slice(0, -1) : path)

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

// The union of the project's entries and the paths agents changed, as one tree. An entry
// ending in `/` is a folder whose contents aren't listed.
export const buildTree = (project: SourceProject): readonly SourceNode[] => {
  const folders = new Set<string>()
  const files = new Set<string>()
  const register = (path: string, folder: boolean): void => {
    for (let parent = parentOf(path); parent !== ""; parent = parentOf(parent)) folders.add(parent)
    ;(folder ? folders : files).add(path)
  }
  for (const entry of project.entries) register(trimmed(entry), entry.endsWith("/"))
  for (const path of Object.keys(project.changes)) register(path, false)
  // A path that is both is a folder: something is inside it.
  for (const path of folders) files.delete(path)

  const children = new Map<string, string[]>()
  for (const path of [...folders, ...files]) {
    const siblings = children.get(parentOf(path)) ?? []
    siblings.push(path)
    children.set(parentOf(path), siblings)
  }
  const ignored = new Set(project.ignored.map(trimmed))
  const writing = new Map<string, string[]>()
  for (const [handle, path] of Object.entries(project.writing))
    writing.set(path, [...(writing.get(path) ?? []), handle])

  const make = (path: string, inherited: boolean): SourceNode => {
    const folder = folders.has(path)
    const hidden = inherited || ignored.has(path)
    const name = path.slice(path.lastIndexOf("/") + 1)
    if (!folder) {
      const change = project.changes[path]
      return {
        path,
        name,
        folder,
        ignored: hidden,
        kind: change?.kind,
        touched: change?.touched ?? {},
        writing: writing.get(path) ?? [],
        changed: change !== undefined,
        children: [],
      }
    }
    const inside = (children.get(path) ?? []).map((child) => make(child, hidden)).toSorted(byOrder)
    return {
      path,
      name,
      folder,
      ignored: hidden,
      kind: undefined,
      touched: latestPerAgent(inside),
      writing: [...new Set(inside.flatMap((child) => child.writing))],
      changed: inside.some((child) => child.changed),
      children: inside,
    }
  }
  return (children.get("") ?? []).map((path) => make(path, false)).toSorted(byOrder)
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

// The rows on screen, top to bottom: a folder's children follow it while it is open.
export const visibleRows = (
  tree: readonly SourceNode[],
  open: ReadonlySet<string>,
): readonly SourceRow[] => {
  const rows: SourceRow[] = []
  const visit = (node: SourceNode, depth: number): void => {
    const isOpen = expandable(node) && open.has(node.path)
    rows.push({ node, depth, open: isOpen })
    if (isOpen) node.children.forEach((child) => visit(child, depth + 1))
  }
  tree.forEach((node) => visit(node, 0))
  return rows
}

// Whether a folder lists anything inside it: one whose contents aren't listed has nothing to open.
export const expandable = (node: SourceNode): boolean => node.folder && node.children.length > 0

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

// The agents a row names: the selected terminal's agent first, then any writing this row now,
// then the most recent writer; past two, the rest fold into a count. Only the selection ranks,
// never the agent under the pointer, or the chips would shuffle beneath it.
export const chipsOf = (
  touched: Readonly<Record<string, number>>,
  writing: readonly string[],
  selected: string | undefined,
): Chips => {
  const at = (handle: string): number => touched[handle] ?? 0
  const latest = (a: string, b: string): number => at(b) - at(a) || (a < b ? -1 : 1)
  const everyone = [...new Set([...Object.keys(touched), ...writing])].toSorted(latest)
  const rank = (handle: string): number =>
    handle === selected ? 0 : writing.includes(handle) ? 1 : 2
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

// Whether the agent changed or is writing this row, or anything inside it.
export const touchedBy = (node: SourceNode, handle: string): boolean =>
  handle in node.touched || node.writing.includes(handle)

// The agent to light: the one whose chip is under the pointer, else the selected terminal's agent
// when it has work in this project. Nothing otherwise.
export const litHandle = (
  project: SourceProject | undefined,
  selected: string | undefined,
  hovered: string | undefined,
): string | undefined => {
  if (hovered) return hovered
  if (!project || !selected) return undefined
  const worked =
    Object.values(project.changes).some((change) => selected in change.touched) ||
    selected in project.writing
  return worked ? selected : undefined
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
