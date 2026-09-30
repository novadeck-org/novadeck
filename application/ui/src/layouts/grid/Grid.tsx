import "./grid.css"
import { Plus } from "lucide-react"
import { useCallback, useLayoutEffect, useRef, useMemo, useState, type ReactNode } from "react"
import {
  getBreakpointFromWidth,
  ResponsiveGridLayout,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout"

import type {
  SizePreset,
  TerminalMetadata,
  GridBreakpoint,
  GridLayouts,
  GridRestoreWidths,
} from "../../model/types"
import type { TerminalLayoutControls } from "../../terminals/WindowShell"
import { ContextMenu } from "../../ui-toolkit/ContextMenu"
import { backgroundPointerHandlers } from "../background"
import { useTerminalVisibility } from "../useTerminalVisibility"
import {
  expandedGridLayouts,
  gridColumns,
  toggleGridWidth,
  type GridWidthToggle,
  visibleGridLayouts,
} from "./layout"

const breakpoints = { wide: 1586, desktop: 1036, tablet: 636, mobile: 0 }

type Props = {
  presets: Record<string, SizePreset>
  restoreWidths: Record<string, GridRestoreWidths>
  onToggleWidth: (id: string, change: GridWidthToggle) => void
  terminals: TerminalMetadata[]
  navigation: number
  selected: string
  onSelect: (id: string) => void
  layouts: GridLayouts
  onLayoutsChange: (layouts: GridLayouts) => void
  minimized: Record<string, boolean>
  hidden: Record<string, boolean>
  preview: string
  onMinimize: (id: string) => void
  onCreate: () => void
  render: (terminal: TerminalMetadata, controls: TerminalLayoutControls) => ReactNode
}

export const Grid = ({
  presets,
  restoreWidths,
  onToggleWidth,
  terminals,
  selected,
  navigation,
  onSelect,
  layouts,
  onLayoutsChange,
  minimized,
  hidden,
  preview,
  onMinimize,
  onCreate,
  render,
}: Props): React.JSX.Element => {
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true })
  const [resizeRequest, setResizeRequest] = useState<{ id: string; navigation: number } | null>(
    null,
  )
  const resized = resizeRequest?.navigation === navigation ? resizeRequest.id : null
  const removed = useTerminalVisibility(hidden)
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
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
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
  const base = useMemo(
    () => visibleGridLayouts(terminals, layouts, minimized, removed),
    [terminals, layouts, minimized, removed],
  )
  const current = base

  useLayoutEffect(() => {
    if (!resized) return
    const breakpoint = getBreakpointFromWidth(breakpoints, width) as GridBreakpoint
    const item = current[breakpoint]?.find((entry) => entry.i === resized)
    const stage = containerRef.current?.closest<HTMLElement>(".grid-stage")
    if (!stage || !item) return
    const top = item.y * 24
    const frame = requestAnimationFrame(() => stage.scrollTo({ top, behavior: "instant" }))
    return () => cancelAnimationFrame(frame)
  }, [resized, current, width, containerRef])

  const resizeToViewport = useCallback(
    (id: string): void => {
      if (!width) return
      const expand = presets[id] !== "large"
      const change = toggleGridWidth(
        id,
        expand,
        terminals,
        layouts,
        minimized,
        removed,
        restoreWidths[id],
      )
      onToggleWidth(id, change)
      setResizeRequest({ id, navigation })
    },
    [
      width,
      minimized,
      terminals,
      layouts,
      removed,
      navigation,
      presets,
      restoreWidths,
      onToggleWidth,
    ],
  )

  const grid = (
    <div
      data-workspace-viewport
      className="grid-viewport relative flex min-h-0 flex-1 overflow-hidden workspace-background"
      aria-label="Terminal grid"
      tabIndex={-1}
      data-has-selection={Boolean(selected)}
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
        className="grid-stage relative z-1 min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-4 [scrollbar-gutter:stable]"
        onTransitionEnd={(event) => {
          const terminal = event.target as HTMLElement
          if (!resized || terminal.dataset.gridTerminal !== resized) return
          const breakpoint = getBreakpointFromWidth(breakpoints, width) as GridBreakpoint
          const item = current[breakpoint]?.find((entry) => entry.i === resized)
          if (item) event.currentTarget.scrollTo({ top: item.y * 24, behavior: "instant" })
        }}
      >
        <div ref={containerRef}>
          {mounted && (
            <ResponsiveGridLayout
              className="terminal-grid"
              width={width}
              breakpoints={breakpoints}
              cols={gridColumns}
              layouts={current}
              rowHeight={8}
              margin={[16, 16]}
              containerPadding={[0, 0]}
              compactor={verticalCompactor}
              dragConfig={{ handle: ".terminal-header", cancel: "button, input", threshold: 5 }}
              resizeConfig={{ handles: ["se"] }}
              onLayoutChange={(_, next) => {
                const saved = expandedGridLayouts(next, layouts, terminals, minimized, removed)
                if (saved !== layouts) onLayoutsChange(saved)
              }}
            >
              {terminals
                .filter((terminal) => !removed[terminal.id])
                .map((terminal) => (
                  <div
                    className={`grid-terminal flex min-h-0 flex-col ${selected === terminal.id ? "selected" : ""} ${minimized[terminal.id] ? "minimized" : ""}`}
                    key={terminal.id}
                    data-grid-terminal={terminal.id}
                    data-preview={preview === terminal.id}
                    inert={hidden[terminal.id] ?? false}
                    aria-hidden={hidden[terminal.id] ?? false}
                    onContextMenu={(event) => event.stopPropagation()}
                  >
                    <div
                      className="grid-terminal-body terminal-visibility min-h-0 flex-1"
                      data-hiding={hidden[terminal.id] ?? false}
                    >
                      {render(terminal, {
                        minimize: {
                          minimized: minimized[terminal.id] ?? false,
                          // Keep output painted while the grid's height transition clips it away.
                          clipContent: true,
                          onToggle: () => onMinimize(terminal.id),
                        },
                        onResizePreset: () => resizeToViewport(terminal.id),
                      })}
                    </div>
                  </div>
                ))}
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
          icon: <Plus size={13} aria-hidden="true" />,
          onSelect: onCreate,
        },
      ]}
      trigger={grid}
    />
  )
}
