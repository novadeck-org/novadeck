import "./grid.css"
import { Accessibility, Feedback, PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom"
import { DragDropProvider, useDraggable } from "@dnd-kit/react"
import type { Team } from "@novadeck/core/derivations"
import type { WindowPlace } from "@novadeck/core/layout/window-place"
import { orderBefore } from "@novadeck/core/roster"
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
import { arrangeGrid, gridGap, gridTileHeight, orderAfterDrag, slotAt } from "./layout"
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
  // Every terminal and window, in an order that holds still as the sidebar's is changed: the
  // tiles are rendered in it, so a tile's page or terminal is never moved in the document,
  // which would reload a page in its own frame.
  terminals: readonly Tile[]
  // The same, by id, in the sidebar's order, which the grid lays them out by.
  listed: readonly string[]
  // The order with each folded team's tabs kept together, as saving a drag would leave it.
  keepFolds: (order: readonly string[]) => string[]
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
  listed,
  keepFolds,
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
  // The tiles on show, and their ids in the sidebar's order.
  const shown = useMemo(
    () => terminals.filter((terminal) => !removed[terminal.id]),
    [terminals, removed],
  )
  const ids = useMemo(() => {
    const on = new Set(shown.map((terminal) => terminal.id))
    return listed.filter((id) => on.has(id))
  }, [shown, listed])

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
  const [dragged, setHeld] = useState<Held | null>(null)
  // A tile closed in the hand is not held any more, and leaves no place behind it.
  const held = dragged !== null && ids.includes(dragged.id) ? dragged : null
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
      // Held within the grid, so the tile never makes it scroll where there is nothing.
      const { tileWidth, height } = arrangeGrid(ids, width)
      // Outside the grid it is no drop, so the tiles go back to where they rest.
      const stage = stageRef.current?.getBoundingClientRect()
      const outside =
        !stage ||
        pointer.x < stage.left ||
        pointer.x > stage.right ||
        pointer.y < stage.top ||
        pointer.y > stage.bottom
      live.current.held = {
        id,
        to: outside ? ids.indexOf(id) : slotAt(point, width, ids.length - 1),
        x: Math.min(Math.max(point.x - live.current.grab.x, 0), width - tileWidth),
        y: Math.min(
          Math.max(point.y - live.current.grab.y, 0),
          Math.max(height - gridTileHeight, 0),
        ),
      }
      setHeld(live.current.held)
    },
    [containerRef, stageRef, width, ids],
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
  // A tile added or gone while one is held moves the slots under a pointer that holds
  // still, so the held tile's place is read again.
  useEffect(() => {
    if (dragging && live.current) follow(live.current.pointer)
  }, [dragging, follow])

  // Read apart from where the held tile is drawn, so the order is worked out again only
  // when the place it would take changes, not on every move of the pointer.
  const heldId = held?.id
  const heldTo = held?.to
  const order = useMemo(() => {
    // What a drop would save: with a folded team's tabs together, so the tiles shown making
    // room are those that move. A tile held where it lies saves nothing, so nothing moves.
    const on = new Set(ids)
    if (heldId !== undefined && heldTo !== undefined) {
      const next = orderAfterDrag(listed, ids, heldId, heldTo)
      return next === listed ? ids : keepFolds(next).filter((id) => on.has(id))
    }
    if (!dropPlace) return ids
    // A window dropped here goes where its placeholder shows it, its folds kept together as
    // the drop saves them.
    return keepFolds(orderBefore(listed, dropGhost, dropPlace.grid.before)).filter(
      (id) => id === dropGhost || on.has(id),
    )
  }, [ids, listed, keepFolds, heldId, heldTo, dropPlace])
  const { boxes, height } = useMemo(() => arrangeGrid(order, width), [order, width])
  const boxOf = useMemo(() => new Map(boxes.map((box) => [box.id, box])), [boxes])
  // The wire is drawn from the tiles at rest, not from where a drag or a drop makes room.
  const wired = useMemo(() => (dragging || dropPlace ? [] : boxes), [boxes, dragging, dropPlace])

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
        const lifted = live.current?.held
        live.current = null
        setHeld(null)
        if (!lifted || event.canceled || !ids.includes(lifted.id)) return
        // Let go outside the grid, it is not a drop on it.
        const { x, y } = event.operation.position.current
        const stage = stageRef.current?.getBoundingClientRect()
        if (!stage || x < stage.left || x > stage.right || y < stage.top || y > stage.bottom) return
        const next = orderAfterDrag(listed, ids, lifted.id, lifted.to)
        if (next !== listed) onReorder([...next])
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
