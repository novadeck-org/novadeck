import "./grid.css"
import type { Team } from "@novadeck/core/derivations"
import { gridColumns } from "@novadeck/core/layout/grid-placement"
import { gridPresetWidth, gridTileHeight } from "@novadeck/core/layout/terminal-size"
import { dropOnGrid, type WindowPlace } from "@novadeck/core/layout/window-place"
import type {
  SizePreset,
  Tile,
  GridBreakpoint,
  GridLayouts,
  GridRestoreWidths,
} from "@novadeck/core/types"
import { useDrag, useDragSession } from "@novadeck/items/drag-session"
import { ContextMenu } from "@novadeck/toolkit/ContextMenu"
import { Plus } from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  getBreakpointFromWidth,
  ResponsiveGridLayout,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout"

import { prefersReducedMotion } from "../../interaction/reduced-motion"
import type { TerminalLayoutControls } from "../../terminals/WindowShell"
import { backgroundPointerHandlers } from "../background"
import { useTerminalVisibility } from "../useTerminalVisibility"
import { GridTeamWire } from "./GridTeamWire"
import {
  dropLayout,
  dropPlaceholder,
  gridMargin,
  gridRow,
  gridRowHeight,
  savedGridLayouts,
  toggleGridWidth,
  type GridWidthToggle,
  visibleGridLayouts,
} from "./layout"
import { tileBoxes } from "./team-route"

const breakpoints = { wide: 1586, desktop: 1036, tablet: 636, mobile: 0 }

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

type Props = {
  presets: Record<string, SizePreset>
  restoreWidths: Record<string, GridRestoreWidths>
  onToggleWidth: (id: string, change: GridWidthToggle) => void
  terminals: readonly Tile[]
  navigation: number
  selected: string
  // Every team's wire runs through the gutters, at rest; the selected terminal's team's lights.
  teams: readonly Team[]
  team: Team | undefined
  onSelect: (id: string) => void
  layouts: GridLayouts
  onLayoutsChange: (layouts: GridLayouts) => void
  hidden: Record<string, boolean>
  preview: string
  onCreate: () => void
  render: (terminal: Tile, controls: TerminalLayoutControls) => ReactNode
}

export const Grid = ({
  presets,
  restoreWidths,
  onToggleWidth,
  terminals,
  selected,
  teams,
  team,
  navigation,
  onSelect,
  layouts,
  onLayoutsChange,
  hidden,
  preview,
  onCreate,
  render,
}: Props): React.JSX.Element => {
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true })
  const [resizeRequest, setResizeRequest] = useState<{ id: string; navigation: number } | null>(
    null,
  )
  const resized = resizeRequest?.navigation === navigation ? resizeRequest.id : null
  const removed = useTerminalVisibility(hidden)
  const stageRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = holdWheel(stage)
    stage.addEventListener("wheel", onWheel, { capture: true, passive: false })
    return () => stage.removeEventListener("wheel", onWheel, { capture: true })
  }, [])
  const lastNavigation = useRef({ navigation: 0, width: 0 })
  useLayoutEffect(() => {
    if (
      resized ||
      !mounted ||
      navigation === 0 ||
      (navigation === lastNavigation.current.navigation && width === lastNavigation.current.width)
    )
      return
    const container = containerRef.current
    if (!container) return
    let frame = 0
    const scroll = (): void => {
      frame = 0
      const terminal = container.querySelector<HTMLElement>(`[data-grid-terminal="${selected}"]`)
      if (!terminal) return
      terminal.scrollIntoView({
        behavior: prefersReducedMotion() ? "instant" : "smooth",
        block: "nearest",
        inline: "nearest",
      })
      lastNavigation.current = { navigation, width }
      observer.disconnect()
    }
    // ResponsiveGridLayout may render the new card after this effect's first frame.
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(scroll)
    })
    observer.observe(container, { childList: true, subtree: true })
    frame = requestAnimationFrame(scroll)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [mounted, navigation, selected, width, containerRef, resized])
  const current = useMemo(
    () => visibleGridLayouts(terminals, layouts, removed),
    [terminals, layouts, removed],
  )
  // Something dragged off a terminal's taskbar can be dropped on the grid. While it's over
  // the grid's free space, a placeholder window sits in the grid under the pointer, and the
  // grid makes room for it as for a window dragged there; dropped, the window takes its
  // place. The grid offers its space to the drag session, and shows the placeholder from
  // what the session says is under the pointer.
  const session = useDragSession()
  // The last place offered: the same cell is the same place, so nothing re-renders as the
  // pointer moves within it.
  const offered = useRef<{
    readonly grid: GridLayouts
    readonly key: string
    readonly place: WindowPlace
  } | null>(null)
  useEffect(
    () =>
      session.offer((x, y) => {
        const container = containerRef.current
        const stage = container?.closest(".grid-stage")
        if (!container || !stage || !width) return null
        if (!document.elementsFromPoint(x, y).some((element) => stage.contains(element)))
          return null
        const bounds = container.getBoundingClientRect()
        const breakpoint = getBreakpointFromWidth(breakpoints, width) as GridBreakpoint
        const columns = gridColumns[breakpoint]
        const columnWidth = (width - gridMargin * (columns - 1)) / columns
        const w = gridPresetWidth(columns, "small")
        const h = Math.ceil((gridTileHeight + gridMargin) / gridRow)
        // Centred on the pointer across, its header on the pointer's row.
        const dropped = dropLayout(
          current[breakpoint] ?? [],
          columns,
          {
            column: Math.round((x - bounds.left) / (columnWidth + gridMargin) - w / 2),
            row: Math.floor((y - bounds.top) / gridRow),
          },
          { w, h },
        )
        if (!dropped) return null
        const { cell } = dropped
        const key = `${breakpoint}:${cell.x},${cell.y}`
        if (offered.current?.grid === current && offered.current.key === key)
          return offered.current.place
        const others = dropped.layout.filter((item) => item.i !== dropPlaceholder)
        // Saved as the layout is, with hidden windows where they were.
        const saved =
          savedGridLayouts({ [breakpoint]: others }, layouts, terminals, removed)[breakpoint] ??
          others
        const place: WindowPlace = { grid: { breakpoint, layout: saved, cell } }
        offered.current = { grid: current, key, place }
        return place
      }),
    [session, containerRef, current, layouts, terminals, removed, width],
  )
  const dropPlace = useDrag((drag) => (drag?.place && "grid" in drag.place ? drag.place : null))
  const dropName = useDrag((drag) => drag?.name ?? "")
  // The grid as it shows now: as it will once the window is dropped, its placeholder where
  // the window goes, while a drag is over it.
  const dropPreview = useMemo(
    () =>
      dropPlace &&
      visibleGridLayouts(
        [...terminals, { id: dropPlaceholder }],
        dropOnGrid(layouts, dropPlaceholder, dropPlace.grid),
        removed,
      ),
    [dropPlace, terminals, layouts, removed],
  )
  const showing = dropPreview ?? current
  // While a tile is dragged or resized the grid's layout isn't the one the wire is drawn
  // from, so the grid says so in an attribute the wire's stylesheet reads: set directly, as
  // a state would render every window again, and cleared by the release wherever it lands.
  const startGesture = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    container.setAttribute("data-gesture", "")
    const end = (): void => {
      container.removeAttribute("data-gesture")
      window.removeEventListener("pointerup", end, true)
      window.removeEventListener("pointercancel", end, true)
    }
    window.addEventListener("pointerup", end, true)
    window.addEventListener("pointercancel", end, true)
  }, [containerRef])
  const shownBreakpoint = width
    ? (getBreakpointFromWidth(breakpoints, width) as GridBreakpoint)
    : null
  const boxes = useMemo(
    () =>
      shownBreakpoint
        ? tileBoxes(
            current[shownBreakpoint] ?? [],
            width,
            gridColumns[shownBreakpoint],
            gridRowHeight,
            gridMargin,
          )
        : [],
    [current, shownBreakpoint, width],
  )

  useLayoutEffect(() => {
    if (!resized) return
    const breakpoint = getBreakpointFromWidth(breakpoints, width) as GridBreakpoint
    const item = current[breakpoint]?.find((entry) => entry.i === resized)
    const stage = containerRef.current?.closest<HTMLElement>(".grid-stage")
    if (!stage || !item) return
    const top = item.y * gridRow
    const frame = requestAnimationFrame(() => stage.scrollTo({ top, behavior: "instant" }))
    return () => cancelAnimationFrame(frame)
  }, [resized, current, width, containerRef])

  const resizeToViewport = useCallback(
    (id: string): void => {
      if (!width) return
      const expand = presets[id] !== "large"
      const change = toggleGridWidth(id, expand, terminals, layouts, removed, restoreWidths[id])
      onToggleWidth(id, change)
      setResizeRequest({ id, navigation })
    },
    [width, terminals, layouts, removed, navigation, presets, restoreWidths, onToggleWidth],
  )

  const grid = (
    <div
      data-workspace-viewport
      className="grid-viewport relative flex min-h-0 flex-1 overflow-clip workspace-background"
      aria-label="Terminal grid"
      tabIndex={-1}
      {...backgroundPointerHandlers}
      onMouseDownCapture={(event) => {
        if ((event.target as Element).closest(".react-resizable-handle")) event.preventDefault()
      }}
      onPointerDownCapture={(event) => {
        // Presses in a portal, such as a dialog a terminal opened, reach here through
        // React but aren't on the grid.
        if (!event.currentTarget.contains(event.target as Node)) return
        setResizeRequest(null)
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
        onTransitionEnd={(event) => {
          const terminal = event.target as HTMLElement
          if (!resized || terminal.dataset.gridTerminal !== resized) return
          const breakpoint = getBreakpointFromWidth(breakpoints, width) as GridBreakpoint
          const item = current[breakpoint]?.find((entry) => entry.i === resized)
          if (item) event.currentTarget.scrollTo({ top: item.y * gridRow, behavior: "instant" })
        }}
      >
        <div ref={containerRef} className="relative">
          {mounted && (
            <GridTeamWire
              teams={teams}
              team={team}
              selected={selected}
              boxes={boxes}
              gap={gridMargin}
              width={width}
              hidden={dropPreview !== null}
            />
          )}
          {mounted && (
            <ResponsiveGridLayout
              className="terminal-grid"
              width={width}
              breakpoints={breakpoints}
              cols={gridColumns}
              layouts={showing}
              rowHeight={gridRowHeight}
              margin={[gridMargin, gridMargin]}
              containerPadding={[0, 0]}
              compactor={verticalCompactor}
              dragConfig={{ handle: ".terminal-header", cancel: "button, input", threshold: 5 }}
              resizeConfig={{ handles: ["se"] }}
              onDragStart={startGesture}
              onResizeStart={startGesture}
              onLayoutChange={(_, next) => {
                // Room made for a placeholder isn't the person's layout until it's dropped.
                if (dropPreview) return
                const saved = savedGridLayouts(next, layouts, terminals, removed)
                if (saved !== layouts) onLayoutsChange(saved)
              }}
            >
              {terminals
                .filter((terminal) => !removed[terminal.id])
                .map((terminal) => (
                  <div
                    className={`grid-terminal flex min-h-0 flex-col ${selected === terminal.id ? "selected" : ""}`}
                    key={terminal.id}
                    data-grid-terminal={terminal.id}
                    data-preview={preview === terminal.id}
                    data-team={
                      team?.lead === terminal.id
                        ? "lead"
                        : team?.workers.includes(terminal.id)
                          ? "worker"
                          : undefined
                    }
                    inert={hidden[terminal.id] ?? false}
                    aria-hidden={hidden[terminal.id] ?? false}
                    onContextMenu={(event) => event.stopPropagation()}
                  >
                    <div
                      className="grid-terminal-body terminal-visibility min-h-0 flex-1"
                      data-hiding={hidden[terminal.id] ?? false}
                    >
                      {render(terminal, {
                        onResizePreset: () => resizeToViewport(terminal.id),
                      })}
                    </div>
                  </div>
                ))}
              {dropPreview && (
                <div key={dropPlaceholder} className="grid-terminal drop-ghost" aria-hidden="true">
                  <span className="drop-ghost-header">{dropName}</span>
                </div>
              )}
            </ResponsiveGridLayout>
          )}
        </div>
      </div>
    </div>
  )
  return (
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
  )
}
