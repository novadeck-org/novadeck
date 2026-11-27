import type { FolderListing, FilesProject, RepoSync } from "@novadeck/core/files"
import { Popover } from "@novadeck/toolkit/Popover"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { ChevronsDownUp } from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from "react"

import {
  keptWorking,
  litSet,
  namedAgents,
  noAgents,
  stripHoverOf,
  stripSlots,
  type Squad,
} from "./files-agents"
import { textWidth } from "./files-fonts"
import { hidesNews, rootRepo, type SyncFeed } from "./files-sync"
import {
  buildTree,
  chipsOf,
  estimateChipWidth,
  estimateNameWidth,
  expandable,
  foldChips,
  initialOpen,
  openedByChange,
  isNote,
  keepListings,
  marksOf,
  visibleLines,
  type Chips as ChipSet,
  type FilesNote,
  type Listings,
  type FilesRow,
} from "./files-tree"
import { placesOf, rowHeight, scrollToLine, windowOf } from "./files-window"
import { FilesStrip } from "./FilesStrip"
import { SyncCard, SyncLine, cardLabel, type SyncCardKind } from "./FilesSync"
import { NoteRow, TreeRow, type Pointed } from "./FilesTreeRows"
import { panelLabels } from "./panel-labels"
import { SidebarPanel } from "./SidebarPanel"
import { useFilterMotion } from "./useFilterMotion"
import { useFolderReader } from "./useFolderReader"
import { usePulses } from "./usePulses"
import { useRepoSync } from "./useRepoSync"
import { useTreeMeasure } from "./useTreeMeasure"
import { useTreeScroll } from "./useTreeScroll"

const noFolders: ReadonlySet<string> = new Set()
const noListings: Listings = new Map()

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")))

// A line's key among the slots, and its slot's data-line.
const lineKey = (line: FilesRow | FilesNote): string =>
  isNote(line) ? `${line.path}\0${line.note}` : line.node.path

// The project's files, a folder read when the person opens it, and read again when the panel is
// shown again or an agent's turn ends. Every line is one fixed height, so the tree draws only the
// rows in view (and a few past each edge) in a box as tall as the whole tree: a long tree open
// costs what a screen of it does. The row holding the Tab stop stays drawn wherever it is, so
// focus is never lost to a scroll; a panel with no height (the sidebar collapsed) or not yet
// measured draws no rows. Where the backend tells what its agents changed (the
// demo), every live agent's work is in them: who owns each file, what they did and which one they
// are writing now. Keeping agents' chips in the strip leaves only their work in the tree: the files
// they touched or are writing and the folders those are in; with nothing kept every file shows.
// Keeping or letting go moves the rows on screen: those that stay slide, the rest fade.
// Lighting an agent otherwise, by selecting its terminal or pointing at a chip, only dims the rest.
const FilesPanelView = ({
  project,
  list,
  turn,
  sync,
  watch,
  onOpenFile,
  onOpenFolder,
  onLit,
  selectedHandle,
  roster,
  squads,
  active,
  visible,
  onHide,
}: {
  // What the demo's agents changed in the project, laid over its files; a runner has none.
  project: FilesProject | undefined
  // Reads a folder of the project, by its path from the project's root.
  list: (folder: string) => Promise<FolderListing>
  // When an agent's turn last ended in the project, which has the folders read again.
  turn: number
  // How the project's git repositories stand against their origins' main, where the backend tells.
  sync?: SyncFeed | undefined
  // Follows the works `project` comes from until the returned release is called, where it
  // comes from them.
  watch?: (() => () => void) | undefined
  // Opens a file of the project, by its path from the root; rejects if it can't be opened.
  onOpenFile: (path: string) => Promise<void>
  // Opens a folder of the project, by its path from the root, in the selected terminal's pane;
  // absent where the backend can't.
  onOpenFolder?: ((path: string) => Promise<void>) | undefined
  // Told the agents the panel lights while it shows (the kept ones, else the selected terminal's),
  // and none when it does not: what an open file preview emphasizes.
  onLit?: ((lit: ReadonlySet<string>) => void) | undefined
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
  // The folders the person closed, which stay closed whatever lands in them; opening one by hand
  // clears it. A folder that comes to hold a change after the first opening opens by itself.
  const [closedFolders, setClosedFolders] = useState<ReadonlySet<string>>(noFolders)
  const [seenTree, setSeenTree] = useState(tree)
  if (seenTree !== tree) {
    setSeenTree(tree)
    if (openFolders !== null) {
      const opening = openedByChange(seenTree, tree, closedFolders)
      if ([...opening].some((path) => !openFolders.has(path)))
        setOpenFolders(new Set([...openFolders, ...opening]))
    }
  }
  const open = openFolders ?? noFolders
  // A root that lists nothing is empty, whatever an agent is said to have changed in it.
  const rootEmpty =
    typeof rootRead === "object" && rootRead.entries.length === 0 && !rootRead.truncated
  const rootTruncated = typeof rootRead === "object" && rootRead.truncated
  // The agents the person keeps lit, any number; this panel remounts with the project, which
  // forgets them. Kept agents that no longer have work here are let go, as nothing in the strip
  // shows them. The tree holds only the work of the ones kept.
  const [kept, setKept] = useState<ReadonlySet<string>>(noAgents)
  const stillKept = useMemo(() => keptWorking(project, kept), [project, kept])
  if (stillKept.size !== kept.size) setKept(stillKept)
  const lines = useMemo(
    () => visibleLines(tree, open, rootTruncated, stillKept),
    [tree, open, rootTruncated, stillKept],
  )
  const rows = useMemo(() => lines.filter((line): line is FilesRow => !isNote(line)), [lines])

  const { read, isReading } = useFolderReader(list, setListings)
  // The works the changes come from are followed while the panel shows.
  useEffect(() => (showing && watch ? watch() : undefined), [showing, watch])
  // The root and the open folders, those the kept agents' work leaves out too, so the tree is
  // current when they're let go: what the panel keeps read while it is shown.
  const wanted = useMemo(() => {
    const all = stillKept.size > 0 ? visibleLines(tree, open) : lines
    return [
      "",
      ...all.flatMap((line) =>
        !isNote(line) && line.node.folder && line.open ? [line.node.path] : [],
      ),
    ]
  }, [lines, tree, open, stillKept])
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
  // The repositories against their origins. Shown, or shown again, or an agent's turn ended: asked
  // again now. The backend moved a checkout to main, or the person's own pull or commit moved it:
  // the files on disk changed, so what is on screen is read again, added and removed files with it.
  const repos = useRepoSync(sync)
  // Shown, the repositories are asked of faster than when only the rail and the notices follow them.
  useEffect(() => (showing ? sync?.retain(true) : undefined), [showing, sync])
  useEffect(() => {
    if (showing) sync?.refresh()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A turn's end asks again.
  }, [showing, turn, sync])
  const standing = repos.map(({ path, moved, head }) => `${path}\0${moved}\0${head}`).join("\n")
  const lastStanding = useRef(standing)
  useEffect(() => {
    const before = lastStanding.current
    lastStanding.current = standing
    if (showing && before !== "" && before !== standing) wantedNow.current.forEach(read)
  }, [standing, showing, read])
  const repoAt = useMemo(
    () => new Map(repos.flatMap((repo) => (repo.path === "" ? [] : [[repo.path, repo] as const]))),
    [repos],
  )
  // The card a mark opened: what landed as it was when the person opened it, or what is behind as
  // it stands. `rect` is where the mark was.
  const [card, setCard] = useState<
    { readonly kind: SyncCardKind; readonly repo: RepoSync; readonly rect: DOMRect } | undefined
  >()
  const [updating, setUpdating] = useState(false)
  // Why the last update was refused, and of which repository: it stands while that one is behind.
  const [refusal, setRefusal] = useState<{ readonly path: string; readonly said: string }>()
  const refusedAt = (path: string): string | undefined =>
    refusal?.path === path && repos.find((repo) => repo.path === path)?.behind
      ? refusal.said
      : undefined
  const live = card && repos.find((repo) => repo.path === card.repo.path)
  const cardRepo = card?.kind === "behind" ? live : card?.repo
  const cardOpen =
    card !== undefined && cardRepo !== undefined && (card.kind === "new" || !!live?.behind)
  const update = (repo: RepoSync): void => {
    if (!sync || updating) return
    setUpdating(true)
    setRefusal(undefined)
    void sync.update(repo.path).then((done) => {
      setUpdating(false)
      if (!done.ok) setRefusal({ path: repo.path, said: done.said })
    })
  }
  const [selected, setSelected] = useState<string | null>(null)
  // A chip can leave from under the pointer, folded into `+N` by another agent's write or a
  // narrower tree, with no pointerleave to say so: the agent stays lit only while that row still
  // shows that chip.
  const [hovered, setHovered] = useState<Pointed | undefined>()
  // The strip's chip under the pointer: its agent, or a lead's whole squad.
  const [stripHover, setStripHover] = useState<string | undefined>()
  const [treeNode, setTreeNode] = useState<HTMLDivElement | null>(null)
  const [rowsNode, setRowsNode] = useState<HTMLDivElement | null>(null)
  const [drawnKey, setDrawnKey] = useState(0)
  const { width: treeWidth, height: treeHeight, fonts } = useTreeMeasure(treeNode, drawnKey)
  const scroll = useTreeScroll(treeNode)
  const view = useMemo(
    () => windowOf(lines.length, scroll.top, treeHeight),
    [lines.length, scroll.top, treeHeight],
  )
  const inView = useMemo(() => lines.slice(view.start, view.end), [lines, view])
  const viewRows = useMemo(() => inView.filter((line): line is FilesRow => !isNote(line)), [inView])
  // What the fonts are read from: rows drawn, and chips drawn on them.
  const nowDrawn = viewRows.some(
    (row) => Object.keys(row.node.touched).length > 0 || row.node.writing.length > 0,
  )
    ? 2
    : viewRows.length > 0
      ? 1
      : 0
  if (drawnKey !== nowDrawn) setDrawnKey(nowDrawn)
  // Rows rank their chips by what is kept or selected only, so pointing never reorders them.
  const ranked = useMemo(
    () => litSet(project, kept, selectedHandle),
    [project, kept, selectedHandle],
  )
  // The chips each row in view shows, folded by its room; an open folder names nobody: its files do.
  const chipsByPath = useMemo(() => {
    const chipWidth = (text: string): number =>
      textWidth(text, text.startsWith("+") ? fonts.more : fonts.chip, estimateChipWidth(text))
    const byPath = new Map<string, ChipSet>()
    for (const row of viewRows) {
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
  }, [viewRows, ranked, treeWidth, fonts])
  // A chip whose row scrolled out of the drawn rows gets no pointerleave to say so.
  if (hovered && !viewRows.some((row) => row.node.path === hovered.path)) setHovered(undefined)
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
  const pointing = pointed !== undefined || (showing && stripPointed !== undefined)
  const lit = useMemo(() => {
    const pointedAt = pointed ? [pointed] : showing ? stripPointed : undefined
    return pointedAt ? new Set(pointedAt) : ranked
  }, [pointed, showing, stripPointed, ranked])
  useEffect(() => {
    onLit?.(showing ? ranked : noAgents)
    return () => onLit?.(noAgents)
  }, [onLit, showing, ranked])
  const following = kept.size === 0 && ranked.size > 0 ? [...ranked][0] : undefined
  // The row that holds the tree's one Tab stop: the last one focused, or the first.
  const [stop, setStop] = useState<string | null>(null)
  const tabStop = rows.some((row) => row.node.path === stop) ? stop : (rows[0]?.node.path ?? null)
  const lineOf = useMemo(
    () => new Map(lines.flatMap((line, index) => (isNote(line) ? [] : [[line.node.path, index]]))),
    [lines],
  )
  const places = useMemo(() => placesOf(lines.map((line) => line.depth)), [lines])
  const keyOf = useMemo(() => new Map(lines.map((line, index) => [lineKey(line), index])), [lines])
  const filter = useMemo(() => [...stillKept].toSorted().join(" "), [stillKept])
  // The lines drawn: those in view, and the Tab stop's row where it is not, so it holds focus and
  // the tree stays one Tab stop (a view with no height draws nothing, the stop included).
  const stopLine = treeHeight !== undefined && tabStop !== null ? lineOf.get(tabStop) : undefined
  const drawn = useMemo(() => {
    const indices = Array.from({ length: view.end - view.start }, (_, at) => view.start + at)
    if (stopLine === undefined || (stopLine >= view.start && stopLine < view.end)) return indices
    return stopLine < view.start ? [stopLine, ...indices] : [...indices, stopLine]
  }, [view, stopLine])

  const {
    pulses,
    end: endPulses,
    add: pulse,
  } = usePulses(project?.changes, viewRows, open, showing)
  // A mark opens its card; opening what landed pulses the files that came in once in the tree.
  const openCard = (repo: RepoSync, kind: SyncCardKind, anchor: HTMLElement): void => {
    const rect = anchor.getBoundingClientRect()
    // Another card open is closed first, which has what it showed seen.
    closeCard()
    if (kind === "new" && repo.landing) pulse(repo.landing.files)
    setCard({ kind, repo, rect })
  }
  // Closing the card of what landed is seeing it: the mark goes, for every window. A landing newer
  // than the one the card showed stays.
  const closeCard = (): void => {
    if (card?.kind === "new" && card.repo.landing) sync?.seen(card.repo.path, card.repo.landing.to)
    setCard(undefined)
  }
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
      setClosedFolders((closed) => new Set([...closed].filter((other) => other !== path)))
    } else {
      next.delete(path)
      setClosedFolders((closed) => new Set(closed).add(path))
    }
    setOpenFolders(next)
  }
  // A file that can't be opened may be gone: its folder is read again.
  const openFile = (row: FilesRow): void => {
    if (row.node.folder) return
    setSelected(row.node.path)
    onOpenFile(row.node.path).catch(() => read(parentOf(row.node.path)))
  }
  // A click opens a file, as Enter does, and folds a folder.
  const activate = (row: FilesRow): void => {
    if (!row.node.folder) openFile(row)
    else if (expandable(row.node)) toggle(row.node.path)
  }
  // A folder shown in the pane; one that can't be opened may be gone: its parent is read again.
  const openFolder = (row: FilesRow): void => {
    onOpenFolder?.(row.node.path).catch(() => read(parentOf(row.node.path)))
  }
  // A row that is not drawn yet is scrolled into view and made the Tab stop, which keeps it drawn,
  // and gets focus once it is.
  const focusWanted = useRef<string | null>(null)
  const focusDrawn = (path: string): boolean => {
    const element = rowsNode?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
    element?.focus()
    return element !== undefined && element !== null
  }
  const focusRow = (row: FilesRow | undefined): void => {
    if (!row || !treeNode) return
    const { path } = row.node
    const index = lineOf.get(path)
    if (index !== undefined && treeHeight !== undefined) {
      const to = scrollToLine(index, treeNode.scrollTop, treeHeight)
      // oxlint-disable-next-line react/immutability -- Scrolling the DOM element, from an event.
      if (to !== treeNode.scrollTop) treeNode.scrollTop = to
      scroll.set(Math.floor(to / rowHeight) * rowHeight)
    }
    setStop(path)
    focusWanted.current = focusDrawn(path) ? null : path
  }
  useLayoutEffect(() => {
    if (focusWanted.current !== null && focusDrawn(focusWanted.current)) focusWanted.current = null
  })
  // Escape in the strip or the tree lets go of every kept agent, back to following the selected
  // terminal. With nothing kept it is left for whatever else listens.
  const onEscape = (event: React.KeyboardEvent): void => {
    if (event.key !== "Escape" || kept.size === 0) return
    event.stopPropagation()
    setKept(noAgents)
  }
  // The tree keyboard pattern; Space and a folder's Enter are the buttons' own click (which opens
  // a file), a file's Enter opens it.
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
  // Keeping an agent, or letting go, slides the rows that stay and fades the rest.
  const ghosts = useFilterMotion({
    tree: treeNode,
    rows: rowsNode,
    filter,
    lineOf: keyOf,
    viewport: treeHeight,
  })
  return (
    <SidebarPanel
      id="files-panel"
      title={panelLabels.files}
      active={active}
      onClose={onHide}
      actions={
        <Tooltip content="Collapse folders">
          <button
            className="icon-button dim quiet size-7"
            type="button"
            aria-label="Collapse folders"
            onClick={() => {
              setClosedFolders((closed) => new Set([...closed, ...open]))
              setOpenFolders(new Set())
            }}
          >
            <ChevronsDownUp size={14} strokeWidth={1.6} />
          </button>
        </Tooltip>
      }
    >
      <SyncLine
        repo={rootRepo(repos)}
        open={card?.repo.path === "" ? card.kind : undefined}
        updating={updating}
        refused={refusedAt("")}
        onOpen={openCard}
        onUpdate={update}
      />
      {card && (
        <Popover
          label={cardLabel(card.kind, card.repo)}
          open={cardOpen}
          onOpenChange={(next) => {
            if (!next) closeCard()
          }}
          anchorRect={() => card.rect}
          placement="right-start"
          className="files-card"
          restoreFocus={false}
        >
          {cardRepo && (
            <SyncCard
              kind={card.kind}
              repo={cardRepo}
              updating={updating}
              refused={refusedAt(card.repo.path)}
              onUpdate={() => update(cardRepo)}
            />
          )}
        </Popover>
      )}
      {slots.length > 0 && (
        <FilesStrip
          slots={slots}
          kept={kept}
          selected={following}
          onKeep={setKept}
          onLight={setStripHover}
          onKeyDown={onEscape}
        />
      )}
      {rootRead === "failed" ? (
        <p className="files-empty text-control">Can't read this project's files.</p>
      ) : rootRead === undefined ? null : rootEmpty ? (
        <p className="files-empty text-control">This project's folder is empty.</p>
      ) : (
        <div
          ref={setTreeNode}
          role="tree"
          aria-label="Project files"
          aria-description={
            stillKept.size > 0
              ? `Only the work of ${namedAgents(stillKept)} is shown.${
                  pointing
                    ? ` Of that, the work of ${namedAgents(lit)} is lit; the rest is dimmed.`
                    : ""
                }`
              : lit.size > 0
                ? `The work of ${namedAgents(lit)} is lit; files and folders they did not touch are dimmed.`
                : "No agent is lit."
          }
          className="files-tree sidebar-scroll mt-2.5 flex min-h-0 flex-1 flex-col overflow-y-auto pb-3"
          data-lit={lit.size > 0 ? [...lit].join(" ") : undefined}
          onKeyDown={onKeyDown}
          onPointerLeave={() => setHovered(undefined)}
        >
          <div
            ref={setRowsNode}
            role="none"
            className="files-rows"
            style={{ height: lines.length * rowHeight }}
          >
            {drawn.map((index) => {
              const line = lines[index]!
              const place = places[index]!
              const key = lineKey(line)
              return (
                <div
                  role="none"
                  key={key}
                  data-line={key}
                  className="files-slot"
                  style={{ top: index * rowHeight }}
                >
                  {isNote(line) ? (
                    <NoteRow line={line} place={place} />
                  ) : (
                    <TreeRow
                      row={line}
                      place={place}
                      chips={chipsByPath.get(line.node.path)}
                      lit={lit}
                      selected={selected === line.node.path}
                      tabStop={tabStop === line.node.path}
                      pulse={pulses[line.node.path]}
                      shownTimes={shownTimes}
                      onActivate={activate}
                      onOpenFolder={onOpenFolder && openFolder}
                      onFocus={setStop}
                      onLight={setHovered}
                      sync={line.node.folder ? repoAt.get(line.node.path) : undefined}
                      syncOpen={card?.repo.path === line.node.path ? card.kind : undefined}
                      hidesNews={line.node.folder && !line.open && hidesNews(line.node.path, repos)}
                      onSync={openCard}
                    />
                  )}
                </div>
              )
            })}
          </div>
          <div ref={ghosts} role="none" className="files-ghosts" aria-hidden="true" inert />
        </div>
      )}
    </SidebarPanel>
  )
}

// Drawn again only as its own props change: the sidebar keeps every panel mounted.
export const FilesPanel = memo(FilesPanelView)
