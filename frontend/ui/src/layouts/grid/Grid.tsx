import "./grid.css"
import { Accessibility, Feedback, PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom"
import { DragDropProvider, useDraggable } from "@dnd-kit/react"
import type { Team } from "@novadeck/core/derivations"
import type { WindowPlace } from "@novadeck/core/layout/window-place"
import { isWindow, orderBefore } from "@novadeck/core/roster"
import { terminalLabel } from "@novadeck/core/terminals/handle"
import type { GridSpan, Tile } from "@novadeck/core/types"
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
import { arrangeGrid, gridGap, orderAfterDrag, slotAt, spanAt } from "./layout"
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
const oneCell: GridSpan = { columns: 1, rows: 1 }
// A span as the Grid shows it: no wider than the columns there are.
const shownSpan = (span: GridSpan, columns: number): GridSpan =>
  span.columns <= columns ? span : { ...span, columns }

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
  // How many cells it spans now, which its corner and the arrow keys on it change.
  readonly span: GridSpan
  readonly onResize: Resize
  readonly render: (terminal: Tile, controls: TerminalLayoutControls) => ReactNode
}

// A tile's corner held at a point of the page, while it is held
// ("held"), once let go ("done"), or let go of with Escape or lost ("cancel"); or a span the
// keys asked for ("keys").
type Resize = (
  id: string,
  change:
    | { readonly kind: "held" | "done"; readonly x: number; readonly y: number }
    | { readonly kind: "cancel" }
    | { readonly kind: "keys"; readonly key: "wider" | "narrower" | "taller" | "shorter" },
) => void

// Where a pointer is, in the page's frame.
const at = (event: React.PointerEvent): { x: number; y: number } => ({
  x: event.clientX,
  y: event.clientY,
})

// The corner a tile is sized by, in whole cells: held and moved, it takes the span nearest
// the pointer; the arrow keys widen, narrow, lengthen or shorten it one cell at a time.
const ResizeCorner = ({
  id,
  name,
  span,
  onResize,
}: {
  readonly id: string
  readonly name: string
  readonly span: GridSpan
  readonly onResize: Resize
}): React.JSX.Element => {
  // The pointer that took the corner, and how to let it go.
  const from = useRef<{ pointer: number } | null>(null)
  const release = useRef<(() => void) | null>(null)
  const letGo = (): void => {
    from.current = null
    release.current?.()
    release.current = null
  }
  useEffect(() => () => release.current?.(), [])
  const keys = {
    ArrowRight: "wider",
    ArrowLeft: "narrower",
    ArrowDown: "taller",
    ArrowUp: "shorter",
  } as const
  return (
    <button
      type="button"
      className="grid-resize"
      aria-label={`Resize ${name}`}
      aria-description={`${span.columns} by ${span.rows} cells; arrow keys change it`}
      onPointerDown={(event) => {
        // One pointer sizes it at a time: another, such as a second finger, is let be.
        if (event.button !== 0 || from.current) return
        event.preventDefault()
        event.stopPropagation()
        const corner = event.currentTarget
        const pointer = event.pointerId
        from.current = { pointer }
        corner.setPointerCapture(pointer)
        // Escape lets go without sizing it, wherever the focus is.
        const escape = (key: KeyboardEvent): void => {
          if (key.key !== "Escape") return
          key.preventDefault()
          key.stopPropagation()
          letGo()
          if (corner.hasPointerCapture(pointer)) corner.releasePointerCapture(pointer)
          onResize(id, { kind: "cancel" })
        }
        window.addEventListener("keydown", escape, { capture: true })
        release.current = () => window.removeEventListener("keydown", escape, { capture: true })
      }}
      onPointerMove={(event) => {
        if (from.current?.pointer === event.pointerId) onResize(id, { kind: "held", ...at(event) })
      }}
      onPointerUp={(event) => {
        if (from.current?.pointer !== event.pointerId) return
        const done = at(event)
        letGo()
        onResize(id, { kind: "done", ...done })
      }}
      onLostPointerCapture={(event) => {
        if (from.current?.pointer !== event.pointerId) return
        letGo()
        onResize(id, { kind: "cancel" })
      }}
      onKeyDown={(event) => {
        const key = keys[event.key as keyof typeof keys]
        if (!key || event.altKey || event.ctrlKey || event.metaKey) return
        event.preventDefault()
        event.stopPropagation()
        onResize(id, { kind: "keys", key })
      }}
    />
  )
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
    span,
    onResize,
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
        <ResizeCorner
          id={terminal.id}
          name={terminalLabel(terminal.name, isWindow(terminal) ? undefined : terminal.handle)}
          span={span}
          onResize={onResize}
        />
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
  // How many cells each tile the person sized spans; the rest span one.
  spans: Readonly<Record<string, GridSpan>>
  // Saves the span the person sized a tile to.
  onResize: (id: string, span: GridSpan) => void
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
  spans,
  onResize,
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

  // A tile whose corner is held: the span it would take, shown before it is saved. One that is
  // gone in the meantime is held no more.
  const [sizing, setSizing] = useState<{ readonly id: string; readonly span: GridSpan } | null>(
    null,
  )
  const resizing = sizing !== null && ids.includes(sizing.id) ? sizing : null
  // Forgotten as soon as its tile goes, so it doesn't come back with the tile.
  if (sizing !== null && resizing === null) setSizing(null)
  const sized = useMemo(
    () => (resizing ? { ...spans, [resizing.id]: resizing.span } : spans),
    [spans, resizing],
  )
  // The tiles as they rest, which a pointer is read against, so what is under it doesn't move
  // as the others make room.
  const rest = useMemo(() => arrangeGrid(ids, width, spans), [ids, width, spans])
  // Where the pointer holding a corner is, in the page's frame, to size the tile again as
  // the Grid scrolls under it.
  const corner = useRef<{ readonly id: string; readonly x: number; readonly y: number } | null>(
    null,
  )
  const resize = useCallback<Resize>(
    (id, change) => {
      corner.current = change.kind === "held" ? { id, x: change.x, y: change.y } : null
      if (change.kind === "cancel") return setSizing(null)
      // The span saved, and the one showing, no wider than the columns there are.
      const saved = spans[id] ?? oneCell
      const showing = { ...saved, columns: Math.min(saved.columns, rest.columns) }
      const keyed = (key: "wider" | "narrower" | "taller" | "shorter"): GridSpan =>
        key === "wider" || key === "narrower"
          ? {
              columns: Math.min(rest.columns, showing.columns + (key === "wider" ? 1 : -1)),
              rows: saved.rows,
            }
          : // Down or up keeps the width it was given, wider than the Grid holds now or not.
            { columns: saved.columns, rows: saved.rows + (key === "taller" ? 1 : -1) }
      // A held corner is measured from the tile's top left where it rests, in the Grid's own
      // frame, so it counts what the Grid scrolled since.
      const cornerAt = (x: number, y: number): GridSpan => {
        const frame = containerRef.current?.getBoundingClientRect()
        const box = rest.boxes.find((each) => each.id === id)
        return frame && box
          ? spanAt(x - frame.left - box.left, y - frame.top - box.top, rest)
          : showing
      }
      const asked = change.kind === "keys" ? keyed(change.key) : cornerAt(change.x, change.y)
      // A width the Grid shows no differently keeps the one it was given, which may be wider
      // than the Grid holds now: only a change the person can see is saved.
      const across = Math.max(1, asked.columns)
      const span = { ...asked, columns: across === showing.columns ? saved.columns : across }
      if (change.kind === "held")
        return setSizing((was) =>
          was?.id === id && was.span.columns === span.columns && was.span.rows === span.rows
            ? was
            : { id, span },
        )
      setSizing(null)
      onResize(id, span)
    },
    [rest, spans, onResize, containerRef],
  )
  // While a corner is held, the Grid scrolls when the pointer nears its top or bottom, as a
  // tile dragged by its header does, and the tile is sized again as it scrolls.
  const sizingNow = resizing !== null
  useEffect(() => {
    const stage = stageRef.current
    if (!sizingNow || !stage) return
    const again = (): void => {
      const pointer = corner.current
      if (pointer) resize(pointer.id, { kind: "held", x: pointer.x, y: pointer.y })
    }
    stage.addEventListener("scroll", again, { passive: true })
    const edge = 48
    let frame = 0
    const step = (): void => {
      const pointer = corner.current
      const bounds = stage.getBoundingClientRect()
      if (pointer) {
        if (pointer.y > bounds.bottom - edge) stage.scrollBy({ top: 12, behavior: "instant" })
        else if (pointer.y < bounds.top + edge) stage.scrollBy({ top: -12, behavior: "instant" })
      }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(frame)
      stage.removeEventListener("scroll", again)
    }
  }, [sizingNow, resize])

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
        const slot = slotAt({ x: x - bounds.left, y: y - bounds.top }, rest, ids, ids.length)
        const before = ids[slot] ?? null
        // The same place is the same value, so nothing re-renders as the pointer moves in it.
        if (offered.current?.before === before) return offered.current.place
        const place: WindowPlace = { grid: { before } }
        offered.current = { before, place }
        return place
      }),
    [session, containerRef, ids, width, rest],
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
      const own = rest.boxes.find((box) => box.id === id)
      const across = own?.width ?? rest.cellWidth
      const down = own?.height ?? 0
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
        to: outside ? ids.indexOf(id) : slotAt(point, rest, ids, ids.length - 1),
        x: Math.min(Math.max(point.x - live.current.grab.x, 0), Math.max(width - across, 0)),
        y: Math.min(Math.max(point.y - live.current.grab.y, 0), Math.max(rest.height - down, 0)),
      }
      setHeld(live.current.held)
    },
    [containerRef, stageRef, width, ids, rest],
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
  const { boxes, height } = useMemo(() => arrangeGrid(order, width, sized), [order, width, sized])
  const boxOf = useMemo(() => new Map(boxes.map((box) => [box.id, box])), [boxes])
  // The wire is drawn from the tiles at rest, not from where a drag or a drop makes room.
  const wired = useMemo(
    () => (dragging || resizing || dropPlace ? [] : boxes),
    [boxes, dragging, resizing, dropPlace],
  )

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
          data-gesture={held || resizing ? "" : undefined}
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
                    span={shownSpan(sized[terminal.id] ?? oneCell, rest.columns)}
                    onResize={resize}
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
