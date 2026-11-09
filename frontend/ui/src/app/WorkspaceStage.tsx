import { allTeams, sameTeam, sameTeams, teamOf } from "@novadeck/core/derivations"
import { orderedTiles, tilesOf } from "@novadeck/core/roster"
import type { GridSpan } from "@novadeck/core/types"
import { memo, Suspense, useCallback, useEffect, useMemo, useState, type RefObject } from "react"

import { createCanvasStays } from "../layouts/canvas/stay"
import type { CanvasHandle } from "../layouts/canvas/types"
import { Focus } from "../layouts/focus/Focus"
import { EmptyWorkspace } from "../shell/EmptyWorkspace"
import { firstFlight, flies, flightAfter } from "../shell/shell-state"
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
import { useFoldedOrder, useReorderTiles } from "./team-fold"
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
    const { context, view, selected, terminals, listed, layout } = useWorkspaceState(
      (workspace) => {
        const state = currentState(workspace)
        return {
          context: currentContext(workspace),
          view: state.view,
          selected: state.selected,
          terminals: tilesOf(state.roster),
          // In the sidebar's order, which Grid and Canvas arrange their windows by.
          listed: orderedTiles(state.roster),
          layout: state.layout,
        }
      },
      shallowEqual,
    )
    // Every team, which Grid and Canvas draw whatever is selected, and the selected
    // terminal's, whose wire lights as the sidebar's rail does.
    const teams = useWorkspaceState(allTeams, sameTeams)
    const team = useWorkspaceState((workspace) => teamOf(workspace, selected), sameTeam)
    const { canvas: canvasLayout, hidden, spans } = layout
    const {
      zen,
      revealCanvas,
      canvasKeyboardFocus,
      shellNavigation,
      focusPreview,
      navigate,
      reordered,
    } = useUiState(
      ({ shell }) => ({
        zen: Boolean(shell.zen),
        navigate: shell.navigate,
        revealCanvas: shell.revealCanvas,
        canvasKeyboardFocus: shell.canvasKeyboardFocus,
        shellNavigation: shell.navigation,
        focusPreview: shell.focusPreview,
        reordered: shell.reordered,
      }),
      shallowEqual,
    )
    // Each session's stay on Canvas (layouts/canvas/stay.ts). The stage outlives each
    // session's view, so Canvas finds its stay again when the person comes back to it from
    // Focus by a window's own button.
    const [stays] = useState(createCanvasStays)
    const stay = useMemo(() => stays.of(context), [stays, context])
    // A navigation that flies is for the view on screen as it was asked, here or in the
    // session it brought to the front (see `flightAfter`).
    const [flight, setFlight] = useState(() => firstFlight(shellNavigation, context, view))
    const after = flightAfter(flight, shellNavigation, context, view)
    if (after !== flight) setFlight(after)
    const flying = flies(after, shellNavigation, context, view)
    // The terminal Focus shows: the selection, a kept preview, or the first terminal.
    const displayed = activeTerminal(terminals, selected, context, focusPreview)?.id
    const { setSelected, add, showSessions, showAll } = commands
    const reorderTiles = useReorderTiles()
    const keepFolds = useFoldedOrder()
    const listedIds = useMemo(() => listed.map((tile) => tile.id), [listed])
    // One callback for the session, so the tiles it reaches don't draw again with each change.
    const setSpan = useCallback(
      (id: string, span: GridSpan) => commands.setSpan(target, id, span),
      [commands, target],
    )
    const preview = hidden[selected] ? selected : ""
    const layoutHidden = useLayoutHidden(hidden, preview)
    return (
      <section
        key={context}
        data-workspace-area
        data-navigate={navigate}
        className={`main-area relative flex min-w-0 flex-1 flex-col ${view}`}
        aria-label={`${view} view`}
      >
        <Suspense
          key={view}
          fallback={
            <div
              role="status"
              aria-label="Loading workspace"
              className="stage-note flex flex-1 items-center justify-center text-heading leading-5"
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
              listed={listedIds}
              keepFolds={keepFolds}
              hidden={layoutHidden}
              spans={spans}
              onResize={setSpan}
              preview={preview}
              selected={selected}
              team={team}
              teams={teams}
              onSelect={setSelected}
              navigation={shellNavigation.count}
              onReorder={reorderTiles}
              onCreate={() => {
                add()
              }}
              render={renderTerminal}
            />
          )}
          {view === "canvas" && (
            <Canvas
              ref={canvas}
              hidden={layoutHidden}
              preview={preview}
              layout={canvasLayout}
              revealOnMount={revealCanvas}
              stay={stay}
              reordered={reordered}
              fitOnNavigate={shellNavigation.move === "fit"}
              flyOnNavigate={flying}
              terminals={listed}
              selected={selected}
              team={team}
              teams={teams}
              keyboardFocusRequest={
                canvasKeyboardFocus?.context === context && canvasKeyboardFocus.id === selected
                  ? canvasKeyboardFocus.request
                  : null
              }
              navigation={shellNavigation.count}
              onSelect={setSelected}
              render={renderTerminal}
            />
          )}
        </Suspense>
        {view !== "focus" &&
          terminals.length > 0 &&
          terminals.every((terminal) => layoutHidden[terminal.id]) && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-center">
              <p className="stage-note text-heading leading-5">All terminals are hidden</p>
              <button
                className="button"
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
