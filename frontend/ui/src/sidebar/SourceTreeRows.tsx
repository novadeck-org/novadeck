import type { SourceChange } from "@novadeck/core/source"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import {
  ChevronRight,
  File,
  FileCode,
  FileJson,
  FileMinus,
  FilePen,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  type LucideIcon,
} from "lucide-react"
import { useCallback } from "react"

import { dimmedBy } from "./source-agents"
import {
  expandable,
  fileIconOf,
  indent,
  latestWrite,
  noteIndent,
  trailGone,
  trailLifeMs,
  trailOpacity,
  type Chips as ChipSet,
  type FileIcon,
  type SourceNote,
  type SourceRow,
} from "./source-tree"

const plainIcons: Readonly<Record<FileIcon, LucideIcon>> = {
  code: FileCode,
  json: FileJson,
  text: FileText,
  file: File,
}

const changedIcons: Readonly<Record<SourceChange, LucideIcon>> = {
  modified: FilePen,
  added: FilePlus,
  deleted: FileMinus,
}

// The chip under the pointer: an agent's handle on one row.
export type Pointed = { readonly path: string; readonly handle: string }

const noteTexts: Readonly<Record<SourceNote["note"], string>> = {
  failed: "Can't read this folder",
  truncated: "More not shown",
  empty: "Empty",
}

// A quiet line at the end of an open folder that couldn't be read in full.
export const NoteRow = ({ line }: { line: SourceNote }): React.JSX.Element => (
  <div role="none" className="source-note-row">
    {Array.from({ length: line.depth }, (_, level) => (
      <span
        key={level}
        className="source-guide"
        aria-hidden="true"
        style={{ left: 12 + indent * level }}
      />
    ))}
    <div
      role="treeitem"
      aria-level={line.depth + 1}
      aria-disabled="true"
      className="source-note text-caption"
      data-note={line.note}
      title={noteTexts[line.note]}
      style={{ paddingLeft: noteIndent(line.depth) }}
    >
      {noteTexts[line.note]}
    </div>
  </div>
)

// Who worked a row, as the chips on its right: two agents at most, or one where the row is too
// narrow to keep its name whole beside two, the rest folded into a count. Pointing at a chip
// lights that agent across the tree; chips are no tab stops, the row's label names everyone, and
// only the kept or selected agents rank first.
const Chips = ({
  row,
  chips,
  lit,
  onLight,
}: {
  row: SourceRow
  chips: ChipSet
  lit: ReadonlySet<string>
  onLight: (handle: string | undefined) => void
}): React.JSX.Element | null => {
  const { node } = row
  const { shown, more, everyone } = chips
  if (shown.length === 0) return null
  return (
    // The row's own label names everyone who changed it, so the chips stay out of what a
    // screen reader reads, and out of the tree, which holds only treeitems and groups.
    <span className="source-chips text-caption" aria-hidden="true">
      {shown.map((handle) => (
        <span
          key={handle}
          className="source-chip"
          data-writing={node.writing.includes(handle)}
          data-lit={lit.has(handle)}
          onPointerEnter={() => onLight(handle)}
          onPointerLeave={() => onLight(undefined)}
        >
          <HandleChip handle={handle} className="handle-plain" />
        </span>
      ))}
      {more > 0 && (
        <span
          className="source-more"
          title={`${everyone.map((handle) => `@${handle}`).join(", ")} · latest first`}
        >
          +{more}
        </span>
      )}
    </span>
  )
}

// A hollow block fading from a file's latest write, by a CSS animation started part-way by a
// negative delay, so nothing renders again as the time passes. It reads the clock when it
// attaches, not while rendering. One too old to show turns invisible but keeps its box, so the
// room a row reserves for it never depends on the time.
const Trail = ({ latest }: { latest: number }): React.JSX.Element => {
  const start = useCallback(
    (element: HTMLSpanElement | null): void => {
      if (!element) return
      const age = Math.max(0, Date.now() - latest)
      element.style.visibility = trailOpacity(age) < trailGone ? "hidden" : ""
      element.style.setProperty("--source-trail-delay", `${-age}ms`)
      element.style.setProperty("--source-trail-life", `${trailLifeMs}ms`)
      element.style.setProperty("--source-trail-opacity", String(trailOpacity(age)))
    },
    [latest],
  )
  return <span ref={start} className="source-trail" aria-hidden="true" />
}

// The marks after a file's name: a block for each agent writing it now, or, once none is, its
// trail. A new write starts the trail over, and so does the panel being shown again: a hidden
// panel's animations restart on display, so the trail is made anew to read its true age.
const Marks = ({
  row,
  shownTimes,
}: {
  row: SourceRow
  shownTimes: number
}): React.JSX.Element | null => {
  const { node } = row
  if (node.folder) return null
  if (node.writing.length > 0)
    return (
      <>
        {node.writing.map((handle) => (
          <span key={handle} className="source-cursor" aria-hidden="true" />
        ))}
      </>
    )
  const latest = latestWrite(node)
  return latest === 0 ? null : <Trail key={`${latest}/${shownTimes}`} latest={latest} />
}

const rowLabel = (row: SourceRow, everyone: readonly string[]): string =>
  [row.node.name, row.node.kind, everyone.map((handle) => `@${handle}`).join(" ")]
    .filter(Boolean)
    .join(", ")

// One file or folder of the tree: its twisty, icon and name, the marks of the agents writing it,
// and the chips of who worked it.
export const TreeRow = ({
  row,
  chips,
  lit,
  selected,
  tabStop,
  pulse,
  shownTimes,
  onActivate,
  onOpenFile,
  onFocus,
  onLight,
}: {
  row: SourceRow
  // The chips the row shows, or undefined for none (an open folder names nobody: its files do).
  chips: ChipSet | undefined
  lit: ReadonlySet<string>
  selected: boolean
  // The tree's one Tab stop.
  tabStop: boolean
  pulse: number | undefined
  shownTimes: number
  onActivate: (row: SourceRow) => void
  onOpenFile: (row: SourceRow) => void
  onFocus: (path: string) => void
  onLight: (pointed: Pointed | undefined) => void
}): React.JSX.Element => {
  const { node, depth, open } = row
  const fileIcon = node.kind ? changedIcons[node.kind] : plainIcons[fileIconOf(node.name)]
  const Icon = node.folder ? (open ? FolderOpen : Folder) : fileIcon
  const everyone = chips?.everyone ?? []
  const branch = expandable(node)
  return (
    <div
      role="none"
      className="item source-row"
      data-kind={node.kind}
      data-folder={node.folder}
      data-ignored={node.ignored}
      data-dim={dimmedBy(node, lit)}
      data-pulse={pulse === undefined ? undefined : pulse % 2 === 1 ? "a" : "b"}
      data-selected={selected}
    >
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          className="source-guide"
          aria-hidden="true"
          style={{ left: 12 + indent * level }}
        />
      ))}
      <button
        type="button"
        role="treeitem"
        className="source-row-select"
        style={{ paddingLeft: 6 + indent * depth }}
        aria-level={depth + 1}
        data-path={node.path}
        tabIndex={tabStop ? 0 : -1}
        aria-expanded={branch ? open : undefined}
        aria-selected={node.folder ? undefined : selected}
        aria-label={rowLabel(row, everyone)}
        onClick={() => onActivate(row)}
        onDoubleClick={() => onOpenFile(row)}
        onFocus={() => onFocus(node.path)}
      >
        <span className="source-twisty" aria-hidden="true">
          {branch && <ChevronRight size={12} strokeWidth={1.5} data-open={open} />}
        </span>
        <span className="source-icon" aria-hidden="true">
          <Icon size={14} strokeWidth={1.5} />
        </span>
        <span className="source-name text-body">{node.name}</span>
        <Marks row={row} shownTimes={shownTimes} />
      </button>
      {chips && (
        <Chips
          row={row}
          chips={chips}
          lit={lit}
          onLight={(handle) =>
            onLight(handle === undefined ? undefined : { path: node.path, handle })
          }
        />
      )}
    </div>
  )
}
