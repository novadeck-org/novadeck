import type { SourceListing, SourceProject } from "@novadeck/core/source"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { ChevronsDownUp } from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { SidebarPanel } from "./SidebarPanel"
import {
  keptWorking,
  litSet,
  namedAgents,
  noAgents,
  stripHoverOf,
  stripSlots,
  type Squad,
} from "./source-agents"
import { textWidth } from "./source-fonts"
import {
  buildTree,
  chipsOf,
  estimateChipWidth,
  estimateNameWidth,
  expandable,
  foldChips,
  initialOpen,
  isNote,
  keepListings,
  marksOf,
  visibleLines,
  type Chips as ChipSet,
  type Listings,
  type SourceRow,
} from "./source-tree"
import { SourceStrip } from "./SourceStrip"
import { NoteRow, TreeRow, type Pointed } from "./SourceTreeRows"
import { useFolderReader } from "./useFolderReader"
import { usePulses } from "./usePulses"
import { useTreeMeasure } from "./useTreeMeasure"

const noFolders: ReadonlySet<string> = new Set()
const noListings: Listings = new Map()

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")))

// The project's files, a folder read when the person opens it, and read again when the panel is
// shown again or an agent's turn ends. Where the backend tells what its agents changed (the
// demo), every live agent's work is in them: who owns each file, what they did and which one they
// are writing now. That only shows what the agents do, and picks nothing: lighting an agent, by
// selecting its terminal, keeping its chip in the strip or pointing at a chip, only dims the rest.
export const SourcePanel = ({
  project,
  list,
  turn,
  onOpenFile,
  selectedHandle,
  roster,
  squads,
  active,
  visible,
  onHide,
}: {
  // What the demo's agents changed in the project, laid over its files; a runner has none.
  project: SourceProject | undefined
  // Reads a folder of the project, by its path from the project's root.
  list: (folder: string) => Promise<SourceListing>
  // When an agent's turn last ended in the project, which has the folders read again.
  turn: number
  // Opens a file of the project, by its path from the root; rejects if it can't be opened.
  onOpenFile: (path: string) => Promise<void>
  // The handle of the workspace's selected terminal.
  selectedHandle: string | undefined
  // The handles of the session's terminals in roster order, and its teams as handles, each lead
  // first: how the agents strip orders and groups the agents.
  roster: readonly string[]
  squads: readonly Squad[]
  // Whether this is the sidebar's panel now.
  active: boolean
  // Whether the sidebar itself is shown, not collapsed.
  visible: boolean
  onHide: () => void
}): React.JSX.Element => {
  const showing = active && visible
  const [listings, setListings] = useState<Listings>(noListings)
  const tree = useMemo(() => buildTree(listings, project), [listings, project])
  // The listings of a folder that vanished are dropped, to be read anew if it comes back.
  const rootRead = listings.get("")
  const survivors = keepListings(listings, tree)
  if (survivors !== listings) setListings(survivors)
  // Folders open once, when the panel first has the project's root; after that only the
  // person's clicks open or close one.
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string> | null>(null)
  if (openFolders === null && typeof listings.get("") === "object")
    setOpenFolders(initialOpen(tree))
  const open = openFolders ?? noFolders
  // A root that lists nothing is empty, whatever an agent is said to have changed in it.
  const rootEmpty =
    typeof rootRead === "object" && rootRead.entries.length === 0 && !rootRead.truncated
  const rootTruncated = typeof rootRead === "object" && rootRead.truncated
  const lines = useMemo(() => visibleLines(tree, open, rootTruncated), [tree, open, rootTruncated])
  const rows = useMemo(() => lines.filter((line): line is SourceRow => !isNote(line)), [lines])

  const { read, isReading } = useFolderReader(list, setListings)
  // The root and the open folders on screen: what the panel keeps read while it is shown.
  const wanted = useMemo(
    () => ["", ...rows.filter((row) => row.node.folder && row.open).map((row) => row.node.path)],
    [rows],
  )
  const wantedNow = useRef(wanted)
  useLayoutEffect(() => {
    wantedNow.current = wanted
  }, [wanted])
  // Shown, or shown again, or an agent's turn ended: everything on screen is read again.
  useEffect(() => {
    if (showing) wantedNow.current.forEach(read)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A turn's end has it read again.
  }, [showing, turn, read])
  // A folder that opens, as the first ones do, is read once if nothing has.
  useEffect(() => {
    if (!showing) return
    for (const folder of wanted) if (!listings.has(folder) && !isReading(folder)) read(folder)
  }, [showing, wanted, listings, read, isReading])
  const [selected, setSelected] = useState<string | null>(null)
  // A chip can leave from under the pointer, folded into `+N` by another agent's write or a
  // narrower tree, with no pointerleave to say so: the agent stays lit only while that row still
  // shows that chip.
  const [hovered, setHovered] = useState<Pointed | undefined>()
  // The agents the person keeps lit, any number; this panel remounts with the project, which
  // forgets them. And the strip's chip under the pointer: its agent, or a lead's whole squad.
  const [kept, setKept] = useState<ReadonlySet<string>>(noAgents)
  const [stripHover, setStripHover] = useState<string | undefined>()
  const [treeNode, setTreeNode] = useState<HTMLDivElement | null>(null)
  const { width: treeWidth, fonts } = useTreeMeasure(treeNode)
  // Rows rank their chips by what is kept or selected only, so pointing never reorders them.
  const ranked = useMemo(
    () => litSet(project, kept, selectedHandle),
    [project, kept, selectedHandle],
  )
  // The chips each row shows, folded by its room; an open folder names nobody: its files do.
  const chipsByPath = useMemo(() => {
    const chipWidth = (text: string): number =>
      textWidth(text, text.startsWith("+") ? fonts.more : fonts.chip, estimateChipWidth(text))
    const byPath = new Map<string, ChipSet>()
    for (const row of rows) {
      const { node } = row
      if (node.folder && row.open) continue
      const chips = chipsOf(node.touched, node.writing, ranked)
      byPath.set(
        node.path,
        chips.shown.length < 2
          ? chips
          : foldChips(chips, {
              width: treeWidth,
              depth: row.depth,
              nameWidth:
                treeWidth === undefined
                  ? 0
                  : textWidth(node.name, fonts.name, estimateNameWidth(node.name)),
              marks: marksOf(node),
              chipWidth,
            }),
      )
    }
    return byPath
  }, [rows, ranked, treeWidth, fonts])
  const pointed =
    showing && hovered && chipsByPath.get(hovered.path)?.shown.includes(hovered.handle)
      ? hovered.handle
      : undefined
  const slots = useMemo(
    () => (project ? stripSlots(project, roster, squads) : []),
    [project, roster, squads],
  )
  // The strip chip under the pointer lights its agent, or a lead's whole squad. A squad can
  // dissolve or the strip go with no pointerleave to say so: the hover counts only while its
  // chip is still in the strip, and is forgotten once it is not.
  const stripPointed = stripHoverOf(slots, stripHover)
  if (stripHover !== undefined && stripPointed === undefined) setStripHover(undefined)
  const lit = useMemo(() => {
    const pointedAt = pointed ? [pointed] : showing ? stripPointed : undefined
    return pointedAt ? new Set(pointedAt) : ranked
  }, [pointed, showing, stripPointed, ranked])
  // Kept agents that no longer have work here are let go, as nothing in the strip shows them.
  const stillKept = useMemo(() => keptWorking(project, kept), [project, kept])
  if (stillKept.size !== kept.size) setKept(stillKept)
  const following = kept.size === 0 && ranked.size > 0 ? [...ranked][0] : undefined
  // The row that holds the tree's one Tab stop: the last one focused, or the first.
  const [stop, setStop] = useState<string | null>(null)
  const tabStop = rows.some((row) => row.node.path === stop) ? stop : (rows[0]?.node.path ?? null)

  const { pulses, end: endPulses } = usePulses(project?.changes, rows, open, showing)
  // Hiding the panel ends the pulses, and showing it again starts the trails over so each reads
  // its true age: a hidden panel's animations restart at full brightness when it shows.
  const [wasShowing, setWasShowing] = useState(showing)
  const [shownTimes, setShownTimes] = useState(0)
  if (wasShowing !== showing) {
    setWasShowing(showing)
    if (showing) setShownTimes(shownTimes + 1)
    else {
      endPulses()
      setHovered(undefined)
      setStripHover(undefined)
    }
  }

  const toggle = (path: string, to?: boolean): void => {
    const next = new Set(open)
    if (to ?? !next.has(path)) {
      next.add(path)
      // Opening shows the folder as it is now, whatever was read before, and so the folders
      // left open inside it, which show again with it.
      read(path)
      for (const inner of open) if (inner.startsWith(`${path}/`)) read(inner)
    } else next.delete(path)
    setOpenFolders(next)
  }
  const activate = (row: SourceRow): void => {
    if (!row.node.folder) setSelected(row.node.path)
    else if (expandable(row.node)) toggle(row.node.path)
  }
  // A file that can't be opened may be gone: its folder is read again.
  const openFile = (row: SourceRow): void => {
    if (row.node.folder) return
    setSelected(row.node.path)
    onOpenFile(row.node.path).catch(() => read(parentOf(row.node.path)))
  }
  const focusRow = (row: SourceRow | undefined): void => {
    if (!row) return
    setStop(row.node.path)
    treeNode?.querySelector<HTMLElement>(`[data-path="${CSS.escape(row.node.path)}"]`)?.focus()
  }
  // Escape in the strip or the tree lets go of every kept agent, back to following the selected
  // terminal. With nothing kept it is left for whatever else listens.
  const onEscape = (event: React.KeyboardEvent): void => {
    if (event.key !== "Escape" || kept.size === 0) return
    event.stopPropagation()
    setKept(noAgents)
  }
  // The tree keyboard pattern; Space and a folder's Enter are the buttons' own click, a file's
  // Enter opens it.
  const onKeyDown = (event: React.KeyboardEvent): void => {
    onEscape(event)
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
        case "Enter":
          if (row.node.folder) return event.repeat
          // Holding the key opens the file once.
          if (!event.repeat) openFile(row)
          return true
        case "ArrowRight":
          if (!expandable(row.node)) return true
          if (!row.open) toggle(row.node.path, true)
          else if ((rows[index + 1]?.depth ?? 0) > row.depth) focusRow(rows[index + 1])
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
      {slots.length > 0 && (
        <SourceStrip
          slots={slots}
          kept={kept}
          selected={following}
          onKeep={setKept}
          onLight={setStripHover}
          onKeyDown={onEscape}
        />
      )}
      {rootRead === "failed" ? (
        <p className="source-empty text-control">Can't read this project's files.</p>
      ) : rootRead === undefined ? null : rootEmpty ? (
        <p className="source-empty text-control">This project's folder is empty.</p>
      ) : (
        <div
          ref={setTreeNode}
          role="tree"
          aria-label="Project files"
          aria-description={
            lit.size > 0
              ? `The work of ${namedAgents(lit)} is lit; files and folders they did not touch are dimmed.`
              : "No agent is lit."
          }
          className="source-tree mt-2.5 flex min-h-0 flex-1 flex-col overflow-y-auto pb-3"
          data-lit={lit.size > 0 ? [...lit].join(" ") : undefined}
          onKeyDown={onKeyDown}
          onPointerLeave={() => setHovered(undefined)}
        >
          {lines.map((line) =>
            isNote(line) ? (
              <NoteRow key={`${line.path}\0${line.note}`} line={line} />
            ) : (
              <TreeRow
                key={line.node.path}
                row={line}
                chips={chipsByPath.get(line.node.path)}
                lit={lit}
                selected={selected === line.node.path}
                tabStop={tabStop === line.node.path}
                pulse={pulses[line.node.path]}
                shownTimes={shownTimes}
                onActivate={activate}
                onOpenFile={openFile}
                onFocus={setStop}
                onLight={setHovered}
              />
            ),
          )}
        </div>
      )}
    </SidebarPanel>
  )
}
