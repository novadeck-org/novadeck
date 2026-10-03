import { memo, Suspense, useCallback, useEffect, useMemo, type RefObject } from "react"

import type { CanvasHandle } from "../layouts/canvas/types"
import { Focus } from "../layouts/focus/Focus"
import { tilesOf } from "../model/roster"
import type { ValueUpdate } from "../model/state"
import type { CanvasLayout, GridLayouts } from "../model/types"
import { EmptyWorkspace } from "../shell/EmptyWorkspace"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { Canvas, Grid, preloadViews } from "./deferred-views"
import {
  activeTerminal,
  currentContext,
  currentState,
  currentTarget,
  sameTarget,
  shallowEqual,
} from "./selectors"
import { renderTerminal } from "./WorkspaceTerminal"

const useLayoutHidden = (hidden: Record<string, boolean>, preview: string) =>
  useMemo(() => (preview ? { ...hidden, [preview]: false } : hidden), [hidden, preview])

// The current session's view, remounted per session so each keeps its own view state.
export const WorkspaceStage = memo(
  ({ canvas }: { readonly canvas: RefObject<CanvasHandle | null> }): React.JSX.Element => {
    const { commands } = useWorkspaceServices()
    // Loads the other views once the workspace has settled after starting.
    useEffect(() => {
      if (typeof requestIdleCallback === "function") {
        const idle = requestIdleCallback(preloadViews, { timeout: 2000 })
        return () => cancelIdleCallback(idle)
      }
      const timer = setTimeout(preloadViews, 1000)
      return () => clearTimeout(timer)
    }, [])
    const target = useWorkspaceState(currentTarget, sameTarget)
    const { context, view, selected, terminals, layout } = useWorkspaceState((workspace) => {
      const state = currentState(workspace)
      return {
        context: currentContext(workspace),
        view: state.view,
        selected: state.selected,
        terminals: tilesOf(state.roster),
        layout: state.layout,
      }
    }, shallowEqual)
    const {
      canvas: canvasLayout,
      grid: gridLayouts,
      gridRestoreWidths,
      gridMinimized,
      sizePresets,
      hidden,
    } = layout
    const { zen, revealCanvas, canvasKeyboardFocus, shellNavigation, focusPreview } = useUiState(
      ({ shell }) => ({
        zen: Boolean(shell.zen),
        revealCanvas: shell.revealCanvas,
        canvasKeyboardFocus: shell.canvasKeyboardFocus,
        shellNavigation: shell.navigation,
        focusPreview: shell.focusPreview,
      }),
      shallowEqual,
    )
    // The terminal Focus shows: the selection, a kept preview, or the first terminal.
    const displayed = activeTerminal(terminals, selected, context, focusPreview)?.id
    const {
      setSelected,
      add,
      showSessions,
      setCanvasLayout: saveCanvasLayout,
      setGridLayouts: saveGridLayouts,
      toggleGridWidth,
      toggleGridMinimized,
      setSizePreset,
      showAll,
    } = commands
    const preview = hidden[selected] ? selected : ""
    const layoutHidden = useLayoutHidden(hidden, preview)
    // Views save layouts for the session they rendered, even after it is left.
    const setCanvasLayout = useCallback(
      (next: ValueUpdate<CanvasLayout>) => saveCanvasLayout(target, next),
      [saveCanvasLayout, target],
    )
    const setGridLayouts = useCallback(
      (layouts: ValueUpdate<GridLayouts>) => saveGridLayouts(target, layouts),
      [saveGridLayouts, target],
    )
    return (
      <section
        key={context}
        data-workspace-area
        className={`main-area relative flex min-w-0 flex-1 flex-col ${view}`}
        aria-label={`${view} view`}
      >
        <Suspense
          key={view}
          fallback={
            <div
              role="status"
              aria-label="Loading workspace"
              className="flex flex-1 items-center justify-center text-sm text-muted"
            >
              Loading workspace…
            </div>
          }
        >
          {view === "focus" && displayed && (
            <Focus
              terminals={terminals}
              displayed={displayed}
              onSelect={setSelected}
              render={renderTerminal}
            />
          )}
          {view === "grid" && (
            <Grid
              terminals={terminals}
              hidden={layoutHidden}
              preview={preview}
              selected={selected}
              onSelect={setSelected}
              navigation={shellNavigation.count}
              presets={sizePresets.grid}
              restoreWidths={gridRestoreWidths}
              onToggleWidth={(terminalId, change) => toggleGridWidth(target, terminalId, change)}
              layouts={gridLayouts}
              onLayoutsChange={setGridLayouts}
              minimized={gridMinimized}
              onMinimize={(terminalId) => toggleGridMinimized(target, terminalId)}
              onCreate={() => {
                add({ beginRename: false })
              }}
              render={renderTerminal}
            />
          )}
          {view === "canvas" && (
            <Canvas
              ref={canvas}
              hidden={layoutHidden}
              preview={preview}
              presets={sizePresets.canvas}
              onPresetChange={(terminalId, preset) =>
                setSizePreset(target, terminalId, "canvas", preset)
              }
              layout={canvasLayout}
              matchCreatedTerminalRatio={zen}
              revealOnMount={revealCanvas}
              fitOnNavigate={shellNavigation.fit}
              onLayoutChange={setCanvasLayout}
              terminals={terminals}
              selected={selected}
              keyboardFocusRequest={
                canvasKeyboardFocus?.context === context && canvasKeyboardFocus.id === selected
                  ? canvasKeyboardFocus.request
                  : null
              }
              navigation={shellNavigation.count}
              onSelect={setSelected}
              onCreate={() => add({ beginRename: false })}
              render={renderTerminal}
            />
          )}
        </Suspense>
        {view !== "focus" &&
          terminals.length > 0 &&
          terminals.every((terminal) => layoutHidden[terminal.id]) && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-muted">All terminals are hidden</p>
              <button
                className="small-button"
                onClick={() =>
                  showAll(
                    target,
                    terminals.map((terminal) => terminal.id),
                  )
                }
              >
                Show all terminals
              </button>
            </div>
          )}
        {!terminals.length && (
          <EmptyWorkspace
            view={view}
            zen={zen}
            onCreate={() => add()}
            onShowSessions={showSessions}
          />
        )}
      </section>
    )
  },
)
