import type { SourceChange, SourceProject } from "@novadeck/core/source"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import {
  ChevronRight,
  ChevronsDownUp,
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { SidebarPanel } from "./SidebarPanel"
import {
  buildTree,
  chipsOf,
  estimateNameWidth,
  expandable,
  fileIconOf,
  foldChips,
  indent,
  initialOpen,
  litHandle,
  rowShowing,
  touchedBy,
  trailGone,
  trailLifeMs,
  trailOpacity,
  visibleRows,
  writtenPaths,
  type Chips as ChipSet,
  type FileIcon,
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

const noFolders: ReadonlySet<string> = new Set()

// Who worked a row, as the chips on its right: two agents at most, or one where the row is too
// narrow to keep its name whole beside two, the rest folded into a count. Pointing at a chip lights that agent across the tree; chips are no tab stops, the
// row's label names everyone, and only the selected terminal's agent ranks first.
const Chips = ({
  row,
  chips,
  lit,
  onLight,
}: {
  row: SourceRow
  chips: ChipSet
  lit: string | undefined
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
          data-lit={handle === lit}
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
// attaches, not while rendering, and hides itself if the write is too old to show.
const Trail = ({ latest }: { latest: number }): React.JSX.Element => {
  const start = useCallback(
    (element: HTMLSpanElement | null): void => {
      if (!element) return
      const age = Math.max(0, Date.now() - latest)
      element.hidden = trailOpacity(age) < trailGone
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
  const latest = Math.max(0, ...Object.values(node.touched))
  return latest === 0 ? null : <Trail key={`${latest}/${shownTimes}`} latest={latest} />
}

// How many marks follow a row's name (see `Marks`).
const marksOf = (node: SourceRow["node"]): number =>
  node.folder ? 0 : node.writing.length > 0 ? node.writing.length : hasTrail(node) ? 1 : 0

const hasTrail = (node: SourceRow["node"]): boolean =>
  Math.max(0, ...Object.values(node.touched)) > 0

// A name's width in the row's font. A canvas measures the real text; where there is none (jsdom)
// or no font is known, a per-character estimate stands in.
let canvas: CanvasRenderingContext2D | null | undefined
const textWidth = (name: string, font: string | undefined): number => {
  if (!font || typeof document === "undefined") return estimateNameWidth(name)
  canvas ??= document.createElement("canvas").getContext("2d")
  if (!canvas) return estimateNameWidth(name)
  canvas.font = font
  return Math.ceil(canvas.measureText(name).width)
}

const rowLabel = (row: SourceRow, everyone: readonly string[]): string =>
  [row.node.name, row.node.kind, everyone.map((handle) => `@${handle}`).join(" ")]
    .filter(Boolean)
    .join(", ")

const Row = ({
  row,
  chips,
  lit,
  selected,
  tabStop,
  pulse,
  shownTimes,
  onActivate,
  onFocus,
  onLight,
}: {
  row: SourceRow
  // The chips the row shows, or undefined for none (an open folder names nobody: its files do).
  chips: ChipSet | undefined
  lit: string | undefined
  selected: boolean
  // The tree's one Tab stop.
  tabStop: boolean
  pulse: number | undefined
  shownTimes: number
  onActivate: (row: SourceRow) => void
  onFocus: (path: string) => void
  onLight: (handle: string | undefined) => void
}): React.JSX.Element => {
  const { node, depth, open } = row
  const FileIconOf = node.kind ? changedIcons[node.kind] : plainIcons[fileIconOf(node.name)]
  const Icon = node.folder ? (open ? FolderOpen : Folder) : FileIconOf
  const everyone = chips?.everyone ?? []
  const branch = expandable(node)
  return (
    <div
      role="none"
      className="item source-row"
      data-kind={node.kind}
      data-folder={node.folder}
      data-ignored={node.ignored}
      data-dim={lit !== undefined && !touchedBy(node, lit)}
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
      {chips && <Chips row={row} chips={chips} lit={lit} onLight={onLight} />}
    </div>
  )
}

// How long a write's pulse plays; the panel clears it by this timer, not by the animation, which
// never ends while the panel is hidden.
export const pulseMs = 1400

// The project's files with every live agent's work in them: who owns each file, what they
// did and which one they are writing now. It shows only what the agents do, and picks
// nothing: lighting an agent, by selecting its terminal or pointing at its chip, only dims
// the rest.
export const SourcePanel = ({
  project,
  selectedHandle,
  active,
  visible,
  onHide,
}: {
  project: SourceProject | undefined
  // The handle of the workspace's selected terminal.
  selectedHandle: string | undefined
  // Whether this is the sidebar's panel now.
  active: boolean
  // Whether the sidebar itself is shown, not collapsed.
  visible: boolean
  onHide: () => void
}): React.JSX.Element => {
  const showing = active && visible
  const tree = useMemo(() => (project ? buildTree(project) : []), [project])
  // Folders open once, when the panel first shows the project; after that only the person's
  // clicks open or close one.
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string> | null>(null)
  if (openFolders === null && active && project) setOpenFolders(initialOpen(tree))
  const open = openFolders ?? noFolders
  const rows = useMemo(() => visibleRows(tree, open), [tree, open])
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | undefined>()
  // A chip can leave from under the pointer, folded into `+N` by another agent's write, with no
  // pointerleave to say so: its agent stays lit only while a row still shows its chip.
  const treeElement = useRef<HTMLDivElement>(null)
  // The tree's width and the name font, which decide how many chips a row has room for; the
  // sidebar is resizable, so a ResizeObserver follows the width. Unknown (nothing folds) until
  // measured, and while the panel is hidden (a width of zero).
  const [treeWidth, setTreeWidth] = useState<number | undefined>()
  const [nameFont, setNameFont] = useState<string | undefined>()
  const [treeNode, setTreeNode] = useState<HTMLDivElement | null>(null)
  const attachTree = useCallback((element: HTMLDivElement | null): void => {
    treeElement.current = element
    setTreeNode(element)
  }, [])
  useLayoutEffect(() => {
    const element = treeNode
    if (!element) return undefined
    const measure = (): void => {
      setTreeWidth(element.clientWidth > 0 ? element.clientWidth : undefined)
      const name = element.querySelector(".source-name")
      if (name) setNameFont(getComputedStyle(name).font || undefined)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [treeNode])
  // The chips each row shows, folded by its room; an open folder names nobody: its files do.
  const chipsByPath = useMemo(() => {
    const byPath = new Map<string, ChipSet>()
    for (const row of rows) {
      const { node } = row
      if (node.folder && row.open) continue
      const chips = chipsOf(node.touched, node.writing, selectedHandle)
      byPath.set(
        node.path,
        chips.shown.length < 2
          ? chips
          : foldChips(chips, {
              width: treeWidth,
              depth: row.depth,
              nameWidth: treeWidth === undefined ? 0 : textWidth(node.name, nameFont),
              marks: marksOf(node),
            }),
      )
    }
    return byPath
  }, [rows, selectedHandle, treeWidth, nameFont])
  const pointed =
    hovered !== undefined &&
    rows.some((row) => chipsByPath.get(row.node.path)?.shown.includes(hovered))
      ? hovered
      : undefined
  const lit = litHandle(project, selectedHandle, pointed)
  // The row that holds the tree's one Tab stop: the last one focused, or the first.
  const [stop, setStop] = useState<string | null>(null)
  const tabStop = rows.some((row) => row.node.path === stop) ? stop : (rows[0]?.node.path ?? null)

  // Every write pulses the row showing its file, counted so the next one restarts the
  // animation. Only a shown panel pulses (a hidden one would replay them all on reopening), the
  // panel starts with none, and a timer forgets each pulse once it has played.
  const [pulses, setPulses] = useState<Readonly<Record<string, number>>>({})
  const [seen, setSeen] = useState(project?.changes)
  if (seen !== project?.changes) {
    setSeen(project?.changes)
    if (seen && project && showing) {
      const onScreen = new Set(rows.map((row) => row.node.path))
      const written = new Set(
        writtenPaths(seen, project.changes)
          .map((path) => rowShowing(path, open))
          .filter((path) => onScreen.has(path)),
      )
      if (written.size > 0)
        setPulses((current) => ({
          ...current,
          ...Object.fromEntries([...written].map((path) => [path, (current[path] ?? 0) + 1])),
        }))
    }
  }
  // Hiding the panel ends the pulses, and showing it again starts the trails over so each reads
  // its true age: a hidden panel's animations restart at full brightness when it shows.
  const [wasShowing, setWasShowing] = useState(showing)
  const [shownTimes, setShownTimes] = useState(0)
  if (wasShowing !== showing) {
    setWasShowing(showing)
    if (showing) setShownTimes(shownTimes + 1)
    else if (Object.keys(pulses).length > 0) setPulses({})
  }
  const timers = useRef(new Map<string, { count: number; id: ReturnType<typeof setTimeout> }>())
  useEffect(() => {
    const running = timers.current
    for (const [path, count] of Object.entries(pulses)) {
      const timer = running.get(path)
      if (timer?.count === count) continue
      clearTimeout(timer?.id)
      const id = setTimeout(() => {
        running.delete(path)
        setPulses(({ [path]: _played, ...rest }) => rest)
      }, pulseMs)
      running.set(path, { count, id })
    }
    for (const [path, timer] of running)
      if (!(path in pulses)) {
        clearTimeout(timer.id)
        running.delete(path)
      }
  }, [pulses])
  useEffect(() => {
    const running = timers.current
    return () => {
      for (const timer of running.values()) clearTimeout(timer.id)
      running.clear()
    }
  }, [])

  const toggle = (path: string, to?: boolean): void => {
    const next = new Set(open)
    if (to ?? !next.has(path)) next.add(path)
    else next.delete(path)
    setOpenFolders(next)
  }
  const activate = (row: SourceRow): void => {
    if (!row.node.folder) setSelected(row.node.path)
    else if (expandable(row.node)) toggle(row.node.path)
  }
  const focusRow = (row: SourceRow | undefined): void => {
    if (!row) return
    setStop(row.node.path)
    treeElement.current
      ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(row.node.path)}"]`)
      ?.focus()
  }
  // The tree keyboard pattern; Enter and Space are the buttons' own click.
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const path = (event.target as HTMLElement).closest<HTMLElement>("[data-path]")?.dataset["path"]
    const index = rows.findIndex((row) => row.node.path === path)
    const row = rows[index]
    if (!row) return
    const handled = ((): boolean => {
      switch (event.key) {
        case "ArrowDown":
          focusRow(rows[Math.min(rows.length - 1, index + 1)])
          return true
        case "ArrowUp":
          focusRow(rows[Math.max(0, index - 1)])
          return true
        case "Home":
          focusRow(rows[0])
          return true
        case "End":
          focusRow(rows[rows.length - 1])
          return true
        case "ArrowRight":
          if (!expandable(row.node)) return true
          if (!row.open) toggle(row.node.path, true)
          else focusRow(rows[index + 1])
          return true
        case "ArrowLeft":
          if (row.open) toggle(row.node.path, false)
          else
            focusRow(
              rows.slice(0, index).findLast((candidate) => candidate.depth === row.depth - 1),
            )
          return true
        default:
          return false
      }
    })()
    if (handled) event.preventDefault()
  }
  return (
    <SidebarPanel
      id="source-panel"
      title="Source"
      active={active}
      onClose={onHide}
      actions={
        <Tooltip content="Collapse folders">
          <button
            className="icon-button dim quiet size-7"
            type="button"
            aria-label="Collapse folders"
            onClick={() => setOpenFolders(new Set())}
          >
            <ChevronsDownUp size={14} strokeWidth={1.6} />
          </button>
        </Tooltip>
      }
    >
      {project ? (
        <div
          ref={attachTree}
          role="tree"
          aria-label="Project files"
          aria-description={
            lit
              ? `@${lit}'s work is lit; files and folders they did not touch are dimmed.`
              : "No agent is lit."
          }
          className="source-tree mt-2.5 flex min-h-0 flex-1 flex-col overflow-y-auto pb-3"
          data-lit={lit}
          onKeyDown={onKeyDown}
        >
          {rows.map((row) => (
            <Row
              key={row.node.path}
              row={row}
              chips={chipsByPath.get(row.node.path)}
              lit={lit}
              selected={selected === row.node.path}
              tabStop={tabStop === row.node.path}
              pulse={pulses[row.node.path]}
              shownTimes={shownTimes}
              onActivate={activate}
              onFocus={setStop}
              onLight={setHovered}
            />
          ))}
        </div>
      ) : (
        <p className="source-empty text-control">No agent has changed anything here yet.</p>
      )}
    </SidebarPanel>
  )
}
