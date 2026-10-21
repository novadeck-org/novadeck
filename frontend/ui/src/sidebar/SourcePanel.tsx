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
  dimmedBy,
  litSet,
  namedAgents,
  noAgents,
  stripItems,
  toggleAgent,
  toggleSquad,
  type Squad,
  type StripItem,
} from "./source-agents"
import {
  buildTree,
  chipsOf,
  estimateChipWidth,
  estimateNameWidth,
  expandable,
  fileIconOf,
  foldChips,
  indent,
  initialOpen,
  latestWrite,
  marksOf,
  rowShowing,
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

// The chip under the pointer: an agent's handle on one row.
type Pointed = { readonly path: string; readonly handle: string }

const noFolders: ReadonlySet<string> = new Set()

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

// A text's width in a font. A canvas measures the text in that font (the family as loaded
// so far: the caller measures again once the web fonts finish loading); where there is no canvas
// (jsdom) or no font is known, `estimate` stands in. Widths are kept by font, and
// forgotten when the fonts change.
let canvas: HTMLCanvasElement | undefined
const widths = new Map<string, number>()
const forgetWidths = (): void => widths.clear()
const textWidth = (text: string, font: string | undefined, estimate: number): number => {
  if (!font || typeof document === "undefined") return estimate
  const key = `${font}\n${text}`
  const known = widths.get(key)
  if (known !== undefined) return known
  canvas ??= document.createElement("canvas")
  const context = canvas.getContext("2d")
  if (!context) return estimate
  context.font = font
  const width = Math.ceil(context.measureText(text).width)
  widths.set(key, width)
  return width
}

// The fonts the row's texts are set in: the name, a handle chip and the `+N`.
type Fonts = {
  readonly name: string | undefined
  readonly chip: string | undefined
  readonly more: string | undefined
}

const noFonts: Fonts = { name: undefined, chip: undefined, more: undefined }

// Read from the tree's rows as they are drawn; a font whose element is not on screen is unknown.
// The `+N` is set like a chip when no row shows one.
const fontsOf = (tree: Element): Fonts => {
  const font = (selector: string): string | undefined => {
    const element = tree.querySelector(selector)
    return element ? fontOf(element) : undefined
  }
  const chip = font(".source-chip .handle-chip")
  return { name: font(".source-name"), chip, more: font(".source-more") ?? chip }
}

const sameFonts = (a: Fonts, b: Fonts): boolean =>
  a.name === b.name && a.chip === b.chip && a.more === b.more

// The canvas font of an element, from its computed longhands: the `font` shorthand reads empty
// in Chromium when the page sets font-feature-settings or font-variant-numeric on a parent.
const fontOf = (element: Element): string | undefined => {
  const { fontStyle, fontWeight, fontSize, fontFamily } = getComputedStyle(element)
  return fontSize && fontFamily
    ? [fontStyle, fontWeight, fontSize, fontFamily].filter(Boolean).join(" ")
    : undefined
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
  lit: ReadonlySet<string>
  selected: boolean
  // The tree's one Tab stop.
  tabStop: boolean
  pulse: number | undefined
  shownTimes: number
  onActivate: (row: SourceRow) => void
  onFocus: (path: string) => void
  onLight: (pointed: Pointed | undefined) => void
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

// An agent's chip in the strip: a toggle for keeping its work lit. A squad's lead stands for
// the whole squad, so pointing at it lights them all and a click keeps or releases them all.
const AgentChip = ({
  handle,
  kept,
  tinted,
  following,
  hint,
  onToggle,
  onLight,
}: {
  handle: string
  kept: boolean
  // Whether the chip wears the kept tint itself, rather than the squad's track having it.
  tinted: boolean
  // Nothing is kept and the selected terminal is this agent's.
  following: boolean
  // What a click does, said on hover: a lead's names its squad, as nothing else marks a lead.
  hint: string
  onToggle: () => void
  onLight: (lit: boolean) => void
}): React.JSX.Element => (
  <button
    type="button"
    className="source-agent text-caption"
    title={hint}
    aria-pressed={kept}
    data-kept={kept && tinted}
    data-following={following}
    onClick={onToggle}
    onPointerEnter={() => onLight(true)}
    onPointerLeave={() => onLight(false)}
  >
    @{handle}
  </button>
)

// The agents with work here as chips above the tree, wrapping onto more lines, squads in a
// faint track with their lead first. A chip keeps its agent lit (any number), a squad's lead the
// whole squad; the tree dims what none of the lit agents touched.
const Strip = ({
  items,
  kept,
  selected,
  onKeep,
  onLight,
  onKeyDown,
}: {
  items: readonly StripItem[]
  kept: ReadonlySet<string>
  // The selected terminal's agent while nothing is kept and it has work here.
  selected: string | undefined
  onKeep: (next: ReadonlySet<string>) => void
  onLight: (handles: readonly string[] | undefined) => void
  onKeyDown: (event: React.KeyboardEvent) => void
}): React.JSX.Element => (
  <div
    role="group"
    aria-label="Light agents"
    className="source-strip mt-2.5"
    onKeyDown={onKeyDown}
    onPointerLeave={() => onLight(undefined)}
  >
    {items.map((item) => {
      if (item.kind === "solo")
        return (
          <AgentChip
            key={item.handle}
            handle={item.handle}
            kept={kept.has(item.handle)}
            tinted
            following={kept.size === 0 && selected === item.handle}
            hint={kept.has(item.handle) ? `Let @${item.handle} go` : `Keep @${item.handle} lit`}
            onToggle={() => onKeep(toggleAgent(kept, item.handle))}
            onLight={(on) => onLight(on ? [item.handle] : undefined)}
          />
        )
      const whole = item.members.every((handle) => kept.has(handle))
      return (
        <div
          key={item.members[0]}
          role="group"
          aria-label={`@${item.members[0]}'s squad`}
          className="source-squad"
          data-kept={whole}
        >
          {item.members.map((handle, index) => (
            <AgentChip
              key={handle}
              handle={handle}
              kept={kept.has(handle)}
              tinted={!whole}
              following={kept.size === 0 && selected === handle}
              hint={
                index === 0
                  ? whole
                    ? `Let @${handle}'s squad go`
                    : `Keep @${handle}'s squad lit`
                  : kept.has(handle)
                    ? `Let @${handle} go`
                    : `Keep @${handle} lit`
              }
              onToggle={() =>
                onKeep(index === 0 ? toggleSquad(kept, item.members) : toggleAgent(kept, handle))
              }
              onLight={(on) => onLight(on ? (index === 0 ? item.members : [handle]) : undefined)}
            />
          ))}
        </div>
      )
    })}
  </div>
)

// How long a write's pulse plays; the panel clears it by this timer, not by the animation, which
// never ends while the panel is hidden.
export const pulseMs = 1400

// The project's files with every live agent's work in them: who owns each file, what they
// did and which one they are writing now. It shows only what the agents do, and picks
// nothing: lighting an agent, by selecting its terminal, keeping its chip in the strip or
// pointing at a chip, only dims the rest.
export const SourcePanel = ({
  project,
  selectedHandle,
  roster,
  squads,
  active,
  visible,
  onHide,
}: {
  project: SourceProject | undefined
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
  const tree = useMemo(() => (project ? buildTree(project) : []), [project])
  // Folders open once, when the panel first shows the project; after that only the person's
  // clicks open or close one.
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string> | null>(null)
  if (openFolders === null && active && project) setOpenFolders(initialOpen(tree))
  const open = openFolders ?? noFolders
  const rows = useMemo(() => visibleRows(tree, open), [tree, open])
  const [selected, setSelected] = useState<string | null>(null)
  // A chip can leave from under the pointer, folded into `+N` by another agent's write or a
  // narrower tree, with no pointerleave to say so: the agent stays lit only while that row still
  // shows that chip.
  const [hovered, setHovered] = useState<Pointed | undefined>()
  // The agents the person keeps lit, any number; this panel remounts with the project, which
  // forgets them. And the strip's chip under the pointer: its agent, or a lead's whole squad.
  const [kept, setKept] = useState<ReadonlySet<string>>(noAgents)
  const [stripHover, setStripHover] = useState<readonly string[] | undefined>()
  const treeElement = useRef<HTMLDivElement>(null)
  // The tree's width and the fonts, which decide how many chips a row has room for; the
  // sidebar is resizable, so a ResizeObserver follows the width. Unknown (nothing folds) until
  // measured, and while the panel is hidden (a width of zero).
  const [treeWidth, setTreeWidth] = useState<number | undefined>()
  const [fonts, setFonts] = useState<Fonts>(noFonts)
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
      const next = fontsOf(element)
      setFonts((known) => (sameFonts(known, next) ? known : next))
    }
    measure()
    let current = true
    const fontsChanged = (): void => {
      if (!current) return
      forgetWidths()
      // The font strings stay the same when a web font loads, but the widths measured before it
      // did not: a new object folds the chips again.
      setFonts(fontsOf(element))
    }
    // A theme sets its own fonts (a mono sans in phosphor) on the root element. Its style also
    // changes for other reasons, as a view's transition, so the measuring waits for the next
    // frame and runs once however many changes came before it.
    const root = typeof document === "undefined" ? undefined : document.documentElement
    let frame: number | undefined
    const themed =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(() => {
            if (!current || frame !== undefined) return
            frame = requestAnimationFrame(() => {
              frame = undefined
              if (current) measure()
            })
          })
    themed?.observe(root!, {
      attributes: true,
      attributeFilter: ["data-theme", "data-scheme", "class", "style"],
    })
    const faces = typeof document === "undefined" ? undefined : document.fonts
    void faces?.ready.then(fontsChanged)
    faces?.addEventListener?.("loadingdone", fontsChanged)
    if (typeof ResizeObserver === "undefined")
      return () => {
        current = false
        if (frame !== undefined) cancelAnimationFrame(frame)
        themed?.disconnect()
        faces?.removeEventListener?.("loadingdone", fontsChanged)
      }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      current = false
      if (frame !== undefined) cancelAnimationFrame(frame)
      themed?.disconnect()
      faces?.removeEventListener?.("loadingdone", fontsChanged)
      observer.disconnect()
    }
  }, [treeNode])
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
  const lit = useMemo(() => {
    const pointedAt = pointed ? [pointed] : showing ? stripHover : undefined
    return pointedAt ? new Set(pointedAt) : ranked
  }, [pointed, showing, stripHover, ranked])
  const items = useMemo(
    () => (project ? stripItems(project, roster, squads) : []),
    [project, roster, squads],
  )
  const following = kept.size === 0 && ranked.size > 0 ? [...ranked][0] : undefined
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
    else {
      if (Object.keys(pulses).length > 0) setPulses({})
      setHovered(undefined)
      setStripHover(undefined)
    }
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
  // Escape in the strip or the tree lets go of every kept agent, back to following the selected
  // terminal. With nothing kept it is left for whatever else listens.
  const onEscape = (event: React.KeyboardEvent): void => {
    if (event.key !== "Escape" || kept.size === 0) return
    event.stopPropagation()
    setKept(noAgents)
  }
  // The tree keyboard pattern; Enter and Space are the buttons' own click.
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
      {project && items.length > 0 && (
        <Strip
          items={items}
          kept={kept}
          selected={following}
          onKeep={setKept}
          onLight={setStripHover}
          onKeyDown={onEscape}
        />
      )}
      {project ? (
        <div
          ref={attachTree}
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
