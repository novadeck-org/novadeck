import "./grid.css"
import { Accessibility, Feedback, PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom"
import { DragDropProvider, useDraggable } from "@dnd-kit/react"
import type { Team } from "@novadeck/core/derivations"
import type { WindowPlace } from "@novadeck/core/layout/window-place"
import type { Tile } from "@novadeck/core/types"
import { useDrag, useDragSession } from "@novadeck/items/drag-session"
import { ContextMenu } from "@novadeck/toolkit/ContextMenu"
import { Plus } from "lucide-react"
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import { prefersReducedMotion } from "../../interaction/reduced-motion"
import type { TerminalLayoutControls } from "../../terminals/WindowShell"
import { backgroundPointerHandlers } from "../background"
import { useTerminalVisibility } from "../useTerminalVisibility"
import { GridTeamWire } from "./GridTeamWire"
import { arrangeGrid, gridGap, moveToSlot, orderAfterDrag, slotAt } from "./layout"
import type { TileBox } from "./team-route"

// The wheel over a window scrolls the grid, unless the window is the selected one and holds
// the focus: only then does what is in it, such as a terminal's history or its program, take
// the wheel. It is taken in the capture, before anything in the window has it, and the grid
// scrolls by hand, as a scroller in the window would otherwise keep it. A zoom gesture is only
// held. A page in its own frame never sends the wheel here; grid.css keeps the pointer from it.
const holdWheel =
  (stage: HTMLElement) =>
  (event: WheelEvent): void => {
    const tile = (event.target as Element).closest<HTMLElement>("[data-grid-terminal]")
    if (!tile || !stage.contains(tile)) return
    if (tile.classList.contains("selected") && tile.contains(document.activeElement)) return
    event.stopPropagation()
    if (event.ctrlKey || event.metaKey) return
    event.preventDefault()
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? stage.clientHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : 1
    stage.scrollBy({ top: event.deltaY * unit, behavior: "instant" })
  }

// The width of the element, kept as it resizes; zero until it is measured.
const useWidth = () => {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

// A tile is lifted by its header, not by what is in it or a button on it. A touch lifts it
// after a hold, so a swipe over the header still scrolls the grid, as the sidebar's tabs do.
const sensors = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 5 })],
    preventActivation: (event) => {
      const target = event.target
      return (
        !(target instanceof Element) ||
        !target.closest(".terminal-header") ||
        target.closest("button, input, textarea, a, [contenteditable]") !== null
      )
    },
  }),
]
// The drag's own look is the grid's: a tile follows the pointer and the others make room.
// dnd-kit's feedback moves a clone of what it drags, which a live terminal can't be, and its
// accessibility markup is for a list's items, not for windows that take the keys.
const plugins: React.ComponentProps<typeof DragDropProvider>["plugins"] = (defaults) => [
  ...defaults.filter((plugin) => plugin !== Accessibility && plugin !== Feedback),
  Feedback.configure({ feedback: "none" }),
]

const noControls: TerminalLayoutControls = {}

type TileProps = {
  readonly terminal: Tile
  readonly box: TileBox
  // Where the tile is held, in the grid's frame, while it is dragged; else it sits in its box.
  readonly held: { readonly x: number; readonly y: number } | null
  readonly selected: boolean
  readonly preview: boolean
  readonly role: "lead" | "worker" | undefined
  readonly hidden: boolean
  readonly hiding: boolean
  readonly render: (terminal: Tile, controls: TerminalLayoutControls) => ReactNode
}

// One window in the grid, placed by its box. Its content is made once for a terminal, so a
// tile that moves (every one does as another is dragged past) draws nothing again.
const GridTile = memo(
  ({
    terminal,
    box,
    held,
    selected,
    preview,
    role,
    hidden,
    hiding,
    render,
  }: TileProps): React.JSX.Element => {
    const { ref } = useDraggable({ id: terminal.id })
    const content = useMemo(() => render(terminal, noControls), [render, terminal])
    const x = held?.x ?? box.left
    const y = held?.y ?? box.top
    return (
      <div
        ref={ref}
        className={`grid-terminal flex min-h-0 flex-col ${selected ? "selected" : ""}`}
        style={{
          width: box.width,
          height: box.height,
          transform: `translate(${x}px, ${y}px)`,
        }}
        data-grid-terminal={terminal.id}
        data-preview={preview}
        data-team={role}
        data-held={held !== null ? "" : undefined}
        inert={hidden}
        aria-hidden={hidden}
        onContextMenu={(event) => event.stopPropagation()}
      >
        <div className="grid-terminal-body terminal-visibility min-h-0 flex-1" data-hiding={hiding}>
          {content}
        </div>
      </div>
    )
  },
)

// A tile being dragged: which, the place it would take among the shown tiles, and where it is
// held, in the grid's frame.
type Held = {
  readonly id: string
  readonly to: number
  readonly x: number
  readonly y: number
}

type Props = {
  // Every terminal and window in the sidebar's order, which the grid follows.
  terminals: readonly Tile[]
  navigation: number
  selected: string
  // Every team's wire runs through the gutters, at rest; the selected terminal's team's lights.
  teams: readonly Team[]
  team: Team | undefined
  onSelect: (id: string) => void
  hidden: Record<string, boolean>
  preview: string
  onCreate: () => void
  // Saves the sidebar's order after a tile is dragged to a place in it.
  onReorder: (order: string[]) => void
  render: (terminal: Tile, controls: TerminalLayoutControls) => ReactNode
}

// Where a tile is dropped on a place in the grid's order, the one the Grid shows a
// placeholder for.
const dropGhost = "drop-placeholder"

export const Grid = ({
  terminals,
  selected,
  teams,
  team,
  navigation,
  onSelect,
  hidden,
  preview,
  onCreate,
  onReorder,
  render,
}: Props): React.JSX.Element => {
  const { ref: containerRef, width } = useWidth()
  const removed = useTerminalVisibility(hidden)
  const stageRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = holdWheel(stage)
    stage.addEventListener("wheel", onWheel, { capture: true, passive: false })
    return () => stage.removeEventListener("wheel", onWheel, { capture: true })
  }, [])
  // The tiles on show, in the sidebar's order.
  const shown = useMemo(
    () => terminals.filter((terminal) => !removed[terminal.id]),
    [terminals, removed],
  )
  const ids = useMemo(() => shown.map((terminal) => terminal.id), [shown])

  // Something dragged off a terminal's taskbar can be dropped on the grid. While it's over
  // the grid, a placeholder sits among the tiles where it would go, and they make room for
  // it; dropped, the window takes the place in the sidebar's order. The grid offers its
  // space to the drag session, and shows the placeholder from what the session says is
  // under the pointer.
  const session = useDragSession()
  const offered = useRef<{ readonly before: string | null; readonly place: WindowPlace } | null>(
    null,
  )
  useEffect(
    () =>
      session.offer((x, y) => {
        const container = containerRef.current
        const stage = container?.closest(".grid-stage")
        if (!container || !stage || !width) return null
        if (!document.elementsFromPoint(x, y).some((element) => stage.contains(element)))
          return null
        const bounds = container.getBoundingClientRect()
        const slot = slotAt({ x: x - bounds.left, y: y - bounds.top }, width, ids.length)
        const before = ids[slot] ?? null
        // The same place is the same value, so nothing re-renders as the pointer moves in it.
        if (offered.current?.before === before) return offered.current.place
        const place: WindowPlace = { grid: { before } }
        offered.current = { before, place }
        return place
      }),
    [session, containerRef, ids, width],
  )
  const dropPlace = useDrag((drag) => (drag?.place && "grid" in drag.place ? drag.place : null))
  const dropName = useDrag((drag) => drag?.name ?? "")

  // A tile dragged by its header: it follows the pointer and the others make room as it
  // goes, as the sidebar's list does. The pointer is read in the grid's frame each time it
  // moves and as the grid scrolls under it.
  const [held, setHeld] = useState<Held | null>(null)
  const live = useRef<{
    held: Held
    grab: { x: number; y: number }
    pointer: { x: number; y: number }
  } | null>(null)
  const dragging = held !== null
  const follow = useCallback(
    (pointer: { x: number; y: number }): void => {
      const container = containerRef.current
      if (!live.current || !container || !width) return
      const bounds = container.getBoundingClientRect()
      const point = { x: pointer.x - bounds.left, y: pointer.y - bounds.top }
      const { id } = live.current.held
      live.current.pointer = pointer
      live.current.held = {
        id,
        to: slotAt(point, width, ids.length - 1),
        x: point.x - live.current.grab.x,
        y: point.y - live.current.grab.y,
      }
      setHeld(live.current.held)
    },
    [containerRef, width, ids],
  )
  useEffect(() => {
    const stage = stageRef.current
    if (!dragging || !stage) return
    const scrolled = (): void => {
      if (live.current) follow(live.current.pointer)
    }
    stage.addEventListener("scroll", scrolled, { passive: true })
    return () => stage.removeEventListener("scroll", scrolled)
  }, [dragging, follow])

  const order = useMemo(() => {
    if (held) return moveToSlot(ids, held.id, held.to)
    if (!dropPlace) return ids
    const at = dropPlace.grid.before === null ? -1 : ids.indexOf(dropPlace.grid.before)
    return moveToSlot(ids, dropGhost, at < 0 ? ids.length : at)
  }, [ids, held, dropPlace])
  const { boxes, height } = useMemo(() => arrangeGrid(order, width), [order, width])
  const boxOf = useMemo(() => new Map(boxes.map((box) => [box.id, box])), [boxes])
  // The wire is drawn from the tiles at rest, not from where a drag or a drop makes room.
  const wired = useMemo(() => (held || dropPlace ? [] : boxes), [boxes, held, dropPlace])

  // Brings the selected tile into view when the person navigates to it or the grid's width
  // changes, and not when another tile is added or goes and it shifts.
  const scrolled = useRef({ navigation: 0, width: 0 })
  useLayoutEffect(() => {
    const box = boxOf.get(selected)
    const stage = stageRef.current
    const container = containerRef.current
    if (
      !box ||
      !stage ||
      !container ||
      !width ||
      navigation === 0 ||
      (navigation === scrolled.current.navigation && width === scrolled.current.width)
    )
      return
    scrolled.current = { navigation, width }
    // As far as the nearest edge, the stage's padding included; a tile taller than the stage
    // is met at its top.
    const pad = container.offsetTop
    const top = container.offsetTop + box.top
    const bottom = top + box.height
    const view = stage.clientHeight
    const target =
      top - pad < stage.scrollTop || bottom - top + 2 * pad > view
        ? top - pad
        : bottom + pad > stage.scrollTop + view
          ? bottom + pad - view
          : stage.scrollTop
    if (target !== stage.scrollTop)
      stage.scrollTo({ top: target, behavior: prefersReducedMotion() ? "instant" : "smooth" })
  }, [navigation, selected, width, containerRef, boxOf])

  const grid = (
    <div
      data-workspace-viewport
      className="grid-viewport relative flex min-h-0 flex-1 overflow-clip workspace-background"
      aria-label="Terminal grid"
      tabIndex={-1}
      {...backgroundPointerHandlers}
      onPointerDownCapture={(event) => {
        // Presses in a portal, such as a dialog a terminal opened, reach here through
        // React but aren't on the grid.
        if (!event.currentTarget.contains(event.target as Node)) return
        const id = (event.target as Element).closest<HTMLElement>("[data-grid-terminal]")?.dataset
          .gridTerminal
        onSelect(id ?? "")
        if (!id) event.currentTarget.focus({ preventScroll: true })
      }}
      onFocusCapture={(event) => {
        const id = (event.target as Element).closest<HTMLElement>("[data-grid-terminal]")?.dataset
          .gridTerminal
        if (id) onSelect(id)
      }}
    >
      <div className="workspace-dots absolute inset-0 canvas-grid" aria-hidden="true" />
      <div className="workspace-dots absolute inset-0 canvas-grid-spotlight" aria-hidden="true" />
      <div
        ref={stageRef}
        className="grid-stage relative z-1 min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
      >
        <div
          ref={containerRef}
          className="relative"
          // While a tile is dragged the wire isn't drawn: the grid says so in an attribute its
          // stylesheet reads.
          data-gesture={held ? "" : undefined}
        >
          {width > 0 && (
            <GridTeamWire
              teams={teams}
              team={team}
              selected={selected}
              boxes={wired}
              gap={gridGap}
              width={width}
              hidden={dropPlace !== null}
            />
          )}
          {width > 0 && (
            <div className="terminal-grid" style={{ height }}>
              {held && boxOf.get(held.id) !== undefined && (
                // Where the dragged tile will land, under the tile in the hand.
                <div
                  className="grid-placeholder"
                  aria-hidden="true"
                  style={{
                    width: boxOf.get(held.id)!.width,
                    height: boxOf.get(held.id)!.height,
                    transform: `translate(${boxOf.get(held.id)!.left}px, ${boxOf.get(held.id)!.top}px)`,
                  }}
                />
              )}
              {shown.map((terminal) => {
                const box = boxOf.get(terminal.id)
                return box ? (
                  <GridTile
                    key={terminal.id}
                    terminal={terminal}
                    box={box}
                    held={held?.id === terminal.id ? held : null}
                    selected={selected === terminal.id}
                    preview={preview === terminal.id}
                    role={
                      team?.lead === terminal.id
                        ? "lead"
                        : team?.workers.includes(terminal.id)
                          ? "worker"
                          : undefined
                    }
                    hidden={hidden[terminal.id] ?? false}
                    hiding={hidden[terminal.id] ?? false}
                    render={render}
                  />
                ) : null
              })}
              {dropPlace && boxOf.get(dropGhost) && (
                <div
                  className="grid-terminal drop-ghost"
                  aria-hidden="true"
                  style={{
                    width: boxOf.get(dropGhost)!.width,
                    height: boxOf.get(dropGhost)!.height,
                    transform: `translate(${boxOf.get(dropGhost)!.left}px, ${boxOf.get(dropGhost)!.top}px)`,
                  }}
                >
                  <span className="drop-ghost-header">{dropName}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
  return (
    <DragDropProvider
      sensors={sensors}
      plugins={plugins}
      onDragStart={(event) => {
        const id = String(event.operation.source?.id)
        const container = containerRef.current
        const box = boxOf.get(id)
        const start = event.operation.position.initial
        if (!container || !box) return
        const bounds = container.getBoundingClientRect()
        live.current = {
          held: { id, to: ids.indexOf(id), x: box.left, y: box.top },
          grab: { x: start.x - bounds.left - box.left, y: start.y - bounds.top - box.top },
          pointer: start,
        }
        follow(event.operation.position.current)
      }}
      onDragMove={(event) => follow(event.operation.position.current)}
      onDragEnd={(event) => {
        const dragged = live.current?.held
        live.current = null
        setHeld(null)
        if (!dragged || event.canceled) return
        const all = terminals.map((terminal) => terminal.id)
        const next = orderAfterDrag(all, ids, dragged.id, dragged.to)
        if (next !== all) onReorder([...next])
      }}
    >
      <ContextMenu
        label="Grid actions"
        items={[
          {
            value: "terminal",
            label: "Terminal",
            icon: <Plus size={14} aria-hidden="true" />,
            onSelect: onCreate,
          },
        ]}
        trigger={grid}
      />
    </DragDropProvider>
  )
}
