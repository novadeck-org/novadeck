import type { ItemId } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import {
  ChevronRight,
  File,
  FileMinus,
  FilePen,
  FilePlus,
  Folder,
  FolderOpen,
  type LucideIcon,
} from "lucide-react"
import { useCallback } from "react"

import type { ItemStore } from "../../store/item-store"
import { Branches } from "./Branches"
import { Counts } from "./Parts"
import type { TreeFile, TreeRow } from "./tree"

// The files the selected layers changed, as the Source panel draws its tree: a row each, in
// folders with guides, its name coloured by how it changed and its lines on the right. A file
// the person opened is gray, until it changes. One click unfolds what the file changed under
// its row, one file at a time; a double click, or Enter, opens it.

const indent = 12

const icons: Readonly<Record<TreeFile["status"], LucideIcon>> = {
  modified: FilePen,
  renamed: FilePen,
  added: FilePlus,
  deleted: FileMinus,
}

const guides = (depth: number): React.JSX.Element[] =>
  Array.from({ length: depth }, (_, level) => (
    <span
      key={level}
      className="source-guide"
      aria-hidden="true"
      style={{ left: 12 + indent * level }}
    />
  ))

const kindOf = (status: TreeFile["status"]): "modified" | "added" | "deleted" =>
  status === "added" ? "added" : status === "deleted" ? "deleted" : "modified"

/** The rows that show: those inside a folded folder do not. */
export const visibleRows = (rows: readonly TreeRow[], folded: readonly string[]): TreeRow[] => {
  const out: TreeRow[] = []
  let hiding: string | undefined
  for (const row of rows) {
    const path = row.kind === "folder" ? row.path : row.file.path
    if (hiding !== undefined && path.startsWith(`${hiding}/`)) continue
    hiding = undefined
    out.push(row)
    if (row.kind === "folder" && folded.includes(row.path)) hiding = row.path
  }
  return out
}

export const FileTree = ({
  rows,
  read,
  unfolded,
  folded,
  onUnfold,
  onOpen,
  onFold,
  itemStore,
  target,
  itemId,
  stamp,
  layers,
}: {
  rows: readonly TreeRow[]
  read: ReadonlySet<string>
  unfolded: string | null
  folded: readonly string[]
  onUnfold: (path: string) => void
  onOpen: (path: string) => void
  onFold: (path: string) => void
  itemStore: ItemStore
  target: WorkspaceTarget
  itemId: ItemId
  stamp: string
  layers: readonly string[]
}): React.JSX.Element => {
  // Arrow keys move between the rows, as in a tree.
  const move = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = items[at + (event.key === "ArrowDown" ? 1 : -1)]
    if (!next) return
    event.preventDefault()
    next.focus()
  }, [])
  return (
    <div
      className="source-tree changes-tree"
      role="tree"
      aria-label="Files changed"
      onKeyDown={move}
    >
      {visibleRows(rows, folded).map((row) => {
        if (row.kind === "folder") {
          const open = !folded.includes(row.path)
          return (
            <div
              key={`d:${row.path}`}
              role="none"
              className="item source-row"
              data-folder="true"
              data-kind={undefined}
              data-selected="false"
            >
              {guides(row.depth)}
              <button
                type="button"
                role="treeitem"
                className="source-row-select"
                style={{ paddingLeft: 6 + indent * row.depth }}
                aria-level={row.depth + 1}
                aria-expanded={open}
                onClick={() => onFold(row.path)}
              >
                <span className="source-twisty" aria-hidden="true">
                  <ChevronRight size={12} strokeWidth={1.5} data-open={open} />
                </span>
                <span className="source-icon" aria-hidden="true">
                  {open ? (
                    <FolderOpen size={14} strokeWidth={1.5} />
                  ) : (
                    <Folder size={14} strokeWidth={1.5} />
                  )}
                </span>
                <span className="source-name text-body">{row.name}</span>
              </button>
            </div>
          )
        }
        const { file } = row
        const Icon = icons[file.status] ?? File
        const open = unfolded === file.path
        return (
          <div key={`f:${file.path}`} className="changes-item" data-open={open || undefined}>
            <div
              role="none"
              className="item source-row diff-file"
              data-kind={kindOf(file.status)}
              data-folder="false"
              data-selected={open}
              data-read={read.has(file.path) || undefined}
              data-path={file.path}
            >
              {guides(row.depth)}
              <button
                type="button"
                role="treeitem"
                className="source-row-select"
                style={{ paddingLeft: 6 + indent * row.depth }}
                aria-level={row.depth + 1}
                aria-expanded={open}
                title={file.path}
                // A double click opens, so its first click does not also fold the file away again.
                onClick={(event) => event.detail <= 1 && onUnfold(file.path)}
                onDoubleClick={() => onOpen(file.path)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  onOpen(file.path)
                }}
              >
                <span className="source-twisty" aria-hidden="true" />
                <span className="source-icon" aria-hidden="true">
                  <Icon size={14} strokeWidth={1.5} />
                </span>
                <span className="source-name text-body">{file.name}</span>
              </button>
              <Counts
                added={file.added}
                removed={file.removed}
                reindented={file.reindented}
                className="changes-pm changes-file-pm"
              />
            </div>
            <Branches
              itemStore={itemStore}
              target={target}
              itemId={itemId}
              stamp={stamp}
              file={file}
              open={open}
              layers={layers}
            />
          </div>
        )
      })}
    </div>
  )
}
