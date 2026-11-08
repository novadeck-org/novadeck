import "./canvas.css"
import type { Arranged } from "@novadeck/core/layout/canvas-arrangement"
import { canvasPointPosition } from "@novadeck/core/layout/window-place"
import { isWindow } from "@novadeck/core/roster"
import type { Tile } from "@novadeck/core/types"
import { useDrag, useDragSession } from "@novadeck/items/drag-session"
import {
  Background,
  getViewportForBounds,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  ViewportPortal,
  useStoreApi,
  type OnNodesChange,
  type XYPosition,
} from "@xyflow/react"
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"

import { prefersReducedMotion } from "../../interaction/reduced-motion"
import { workspaceOverlayOpen, workspaceShortcutTarget } from "../../interaction/shortcuts"
import { backgroundPointerHandlers } from "../background"
import { legibleZoom } from "../useSeen"
import { useTerminalVisibility } from "../useTerminalVisibility"
import { CanvasTeamWire } from "./CanvasTeamWire"
import {
  canvasStep,
  chromeScaleAt,
  fitOptions,
  inSight,
  terminalHeaderHeight,
  windowSize,
} from "./geometry"
import { createNodeVisibility } from "./nodeVisibility"
import { beginStay, continueStay, moveInStay, samePoint, stayPlaces, type CanvasStay } from "./stay"
import { NodeVisibilityContext, TerminalContent, nodeTypes } from "./TerminalNode"
import type {
  CanvasProps,
  CanvasHandle,
  CanvasViewport,
  TerminalCanvasProps,
  TerminalNode,
} from "./types"
import { useCanvasNavigation } from "./useCanvasNavigation"
import { useCanvasVisit } from "./useCanvasVisit"
export type { CanvasHandle } from "./types"

// The chrome that reads `--_canvas-chrome-scale` (canvas.css, terminal-status.css).
const chromeReaders = ".terminal-heading, .terminal-ending"

// How long a window dropped from a taskbar takes to settle onto the canvas's grid.
const settleMs = 160

// How long the windows take to glide where the canvas arranged them (canvas.css).
const glideMs = 160

// The room the canvas arranges for where it can't measure its own, as under a test.
const unmeasured = { width: 1280, height: 800 }

const origin: Readonly<XYPosition> = { x: 0, y: 0 }

const TerminalCanvas = ({
  layout,
  revealOnMount,
  stay: held,
  reordered,
  fitOnNavigate,
  flyOnNavigate,
  terminals,
  hidden,
  preview,
  selected,
  team,
  teams,
  keyboardFocusRequest,
  navigation,
  onSelect,
  render,
  handleRef,
}: TerminalCanvasProps): React.JSX.Element => {
  const removed = useTerminalVisibility(hidden)
  const {
    fitView,
    fitBounds,
    zoomIn,
    zoomOut,
    getViewport,
    setViewport,
    getNode,
    setNodes,
    updateNode,
    screenToFlowPosition,
  } = useReactFlow<TerminalNode>()
  const store = useStoreApi<TerminalNode>()
  // The viewport's size is read where it's needed, never subscribed to: it changes every
  // frame while the sidebar slides, and a render per frame rebuilds every window. What
  // renders from it subscribes coarsely: the zoom limit in whole steps.
  const viewportSize = useCallback((): { width: number; height: number } => {
    const { width, height } = store.getState()
    return { width, height }
  }, [store])
  const fitZoom = useStore(
    (state) => Math.floor(Math.min(state.width / 320, state.height / 200) * 2) / 2,
  )
  // Whether a node's text can be read at the zoom; the selector changes only as it crosses.
  const legible = useStore((state) => state.transform[2] >= legibleZoom)
  // The stay it opens as it was left with, if it does: only then does it keep that camera.
  const [kept] = useState(() => (revealOnMount ? held.kept(reordered) : undefined))
  const initialViewport = kept?.camera
  const maxZoom = Math.max(1.5, initialViewport?.zoom ?? 1, fitZoom)
  const container = useRef<HTMLDivElement>(null)
  const [visibility] = useState(createNodeVisibility)
  const { visit, animateVisit } = useCanvasVisit(handleRef)
  // The camera as the move under way began, or last left it: a move the person makes ends
  // a visit's return point; one the canvas makes does not.
  const lastViewport = useRef<CanvasViewport>(initialViewport ?? { x: 0, y: 0, zoom: 1 })
  // The chrome's scale is a CSS variable, but setting it on the canvas restyles everything
  // inside, thousands of terminal rows included, on every frame of a zoom. So a zoom sets
  // it only on the chrome that reads it, and the canvas takes it once the zoom rests, for
  // chrome that mounts afterwards.
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    let zoom = store.getState().transform[2]
    let resting: ReturnType<typeof setTimeout> | undefined
    element.style.setProperty("--_canvas-chrome-scale", String(chromeScaleAt(zoom)))
    const unsubscribe = store.subscribe((state) => {
      if (state.transform[2] === zoom) return
      zoom = state.transform[2]
      const scale = String(chromeScaleAt(zoom))
      for (const chrome of element.querySelectorAll<HTMLElement>(chromeReaders))
        chrome.style.setProperty("--_canvas-chrome-scale", scale)
      clearTimeout(resting)
      resting = setTimeout(() => element.style.setProperty("--_canvas-chrome-scale", scale), 150)
    })
    return () => {
      unsubscribe()
      clearTimeout(resting)
    }
  }, [store])
  // The windows the canvas arranges: those not hidden, in the sidebar's order, each with
  // the window that leads it. A hidden terminal shown while it is selected (`preview`) is
  // not one of them: looking at it arranges nothing.
  const tiles = useMemo((): readonly Arranged[] => {
    const leads = new Map(
      teams.flatMap((each) => each.workers.map((worker) => [worker, each.lead] as const)),
    )
    return terminals
      .filter((terminal) => !hidden[terminal.id] && terminal.id !== preview)
      .map((terminal) => ({ id: terminal.id, lead: leads.get(terminal.id) }))
  }, [terminals, hidden, preview, teams])
  // The room the canvas has, which decides how its windows are packed. Read when they are
  // arranged afresh, never followed: it changes every frame while the sidebar slides.
  const room = useCallback((): { width: number; height: number } => {
    const element = container.current
    return {
      width: element?.clientWidth || unmeasured.width,
      height: element?.clientHeight || unmeasured.height,
    }
  }, [])
  // This stay on Canvas (stay.ts): as it was left, come back to from Focus by a window's own
  // button, and afresh otherwise. It begins once the canvas has its room, before the first
  // paint, and its windows mount where it puts them.
  const stay = useRef<CanvasStay | null>(null)
  const [opened, setOpened] = useState<ReadonlyMap<string, XYPosition> | null>(null)
  useLayoutEffect(() => {
    if (stay.current) return
    const first = kept ? continueStay(kept.stay, tiles) : beginStay(tiles, room())
    stay.current = first
    setOpened(stayPlaces(first))
  }, [kept, room, tiles])
  // The sidebar's order the windows were last arranged afresh for.
  const arrangedFor = useRef(reordered)
  // Leaving, it hands its stay and camera to the stage, for coming back by a window's own
  // button. Leaving ends a visit as though the person came back from it: the camera kept
  // is where the visit began, so a double-click on returning flies in again, not to where
  // the camera already is.
  useEffect(
    () => () => {
      if (stay.current) held.keep(stay.current, arrangedFor.current, visit.home ?? getViewport())
    },
    [getViewport, held, visit],
  )
  const knownTerminals = useRef(new Set(terminals.map((terminal) => terminal.id)))
  const createdPositions = useRef(new Map<string, XYPosition>())
  // What the layout last saved of each window, where one was dropped on the canvas: a
  // newer saving is a drop to honor, even onto the same point. What was saved before this
  // canvas opened is not.
  const [drops] = useState(() => new Map(Object.entries(layout.geometry)))
  const dragging = useRef(new Set<string>())
  const arranging = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(arranging.current), [])
  // Something dragged off a terminal's taskbar can be dropped on the empty canvas: a ghost
  // of its window follows the pointer there, freely, as a dragged window does; dropped,
  // its window opens where the ghost was and settles onto the canvas's grid. The canvas
  // offers its space to the drag session, and draws the ghost from what the session says
  // is under the pointer.
  const session = useDragSession()
  useEffect(
    () =>
      session.offer((x, y) => {
        const under = document.elementsFromPoint(x, y)
        const overPane = under.some((element) => element.classList.contains("react-flow__pane"))
        const overNode = under.some((element) => element.closest(".react-flow__node"))
        if (!overPane || overNode) return null
        // Its window would open with its header under the pointer, at a new window's size.
        const point = screenToFlowPosition({ x, y })
        return {
          canvas: { x: point.x - windowSize.width / 2, y: point.y - terminalHeaderHeight / 2 },
        }
      }),
    [session, screenToFlowPosition],
  )
  const ghost = useDrag((drag) =>
    drag?.place && "canvas" in drag.place ? drag.place.canvas : null,
  )
  const ghostName = useDrag((drag) => drag?.name ?? "")
  // Where the ghost was last: a window opening at its snapped place opens there first,
  // then settles, as `settling` says.
  const lastGhost = useRef<XYPosition | null>(null)
  // Before the drop that ends the drag can open a window, whatever the timing.
  useLayoutEffect(() => {
    if (ghost) lastGhost.current = ghost
  }, [ghost])
  const stacking = useRef<string[]>([])
  // The terminal whose sheet revealed itself last, kept above the rest (the selection too)
  // until the selection moves, so no window draws over its sheet. Not a selection.
  const revealed = useRef<{ id: string; selected: string } | null>(null)
  // Read when a sheet reveals itself, which holds the callback it first got.
  const selectedNow = useRef(selected)
  useEffect(() => {
    selectedNow.current = selected
  }, [selected])
  // The selected window takes its screen the moment it is in sight; the rest take turns.
  useEffect(() => {
    visibility.select(selected || undefined)
  }, [visibility, selected])
  // Where the camera frames a terminal's window whole: its fly-to's destination.
  const framing = useCallback(
    (id: string): CanvasViewport | null => {
      const node = getNode(id)
      const size = viewportSize()
      if (!node || !size.width || !size.height) return null
      return getViewportForBounds(
        {
          ...node.position,
          ...windowSize,
        },
        size.width,
        size.height,
        0,
        Infinity,
        0,
      )
    },
    [getNode, viewportSize],
  )
  // Going to a terminal from outside the canvas flies in to it, as its header's double-click
  // does, but never back out.
  const flyIn = useCallback(
    (id: string): void => {
      const destination = framing(id)
      if (!destination) return
      const flight = visit.enter(id, getViewport(), destination)
      if (flight) animateVisit(flight)
    },
    [animateVisit, framing, getViewport, visit],
  )
  const entrySheets = useRef<Map<string, { right: number; height: number }> | null>(new Map())
  const takeEntrySheets = useCallback(() => {
    const sheets = entrySheets.current ?? new Map()
    entrySheets.current = null
    return sheets
  }, [])
  const initializeViewport = useCanvasNavigation({
    navigation,
    selected,
    hidden,
    fitOnNavigate,
    flyOnNavigate,
    restored: kept !== undefined,
    initialViewport,
    viewportSize,
    container,
    createdPositions,
    visit,
    takeEntrySheets,
    flyIn,
  })
  const fitAll = useCallback((): void => {
    visit.clear()
    void fitView({
      ...fitOptions,
      nodes: terminals
        .filter((terminal) => !hidden[terminal.id])
        .map((terminal) => ({ id: terminal.id })),
    })
  }, [fitView, terminals, hidden, visit])
  // XYFlow owns a drag while it lasts. The window stays where the person leaves it, on the
  // canvas's grid, until this stay ends: nothing of it is saved.
  const onNodesChange: OnNodesChange<TerminalNode> = useCallback(
    (changes) => {
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          if (change.dragging) dragging.current.add(change.id)
          else if (dragging.current.delete(change.id) && stay.current) {
            const position = canvasPointPosition(change.position)
            stay.current = moveInStay(stay.current, change.id, position)
            updateNode(change.id, (node) => ({ ...node, position }))
          }
        }
        if (change.type === "select" && change.selected) onSelect(change.id)
      }
    },
    [onSelect, updateNode],
  )

  const flyTo = useCallback(
    (terminal: Tile) => {
      if (visit.flying) return
      if (!getNode(terminal.id)) return
      onSelect(terminal.id)
      const destination = framing(terminal.id)
      if (!destination) return
      const flight = visit.begin(terminal.id, getViewport(), destination)
      if (!flight) return
      animateVisit(flight)
    },
    [animateVisit, framing, getNode, getViewport, onSelect, visit],
  )

  const nodeFrom = useCallback(
    (terminal: Tile, position: XYPosition | undefined): TerminalNode => ({
      id: terminal.id,
      type: "terminal",
      hidden: removed[terminal.id] ?? false,
      position: position ?? origin,
      ...windowSize,
      dragHandle: ".terminal-header",
      draggable: selected === terminal.id && !hidden[terminal.id],
      selectable: !hidden[terminal.id],
      focusable: !hidden[terminal.id],
      selected: selected === terminal.id,
      ariaLabel: `${terminal.name} terminal`,
      data: {
        preview: preview === terminal.id,
        team:
          team?.lead === terminal.id
            ? "lead"
            : team?.workers.includes(terminal.id)
              ? "worker"
              : undefined,
        focusRequest: selected === terminal.id ? keyboardFocusRequest : null,
        hiding: hidden[terminal.id] ?? false,
      },
    }),
    [hidden, preview, removed, selected, team, keyboardFocusRequest],
  )

  const contentOf = useCallback(
    (id: string, onScreen: boolean): ReactNode => {
      const terminal = terminals.find((item) => item.id === id)
      if (!terminal) return null
      return render(terminal, {
        onScreen,
        legible,
        onFlyTo: () => flyTo(terminal),
        onReveal: ({ right, height }) => {
          // On entry every open sheet reveals itself in turn: the selected window's own
          // sheet keeps the window on top, as it was before.
          const entering = entrySheets.current
          if (entering && id !== selectedNow.current && entering.has(selectedNow.current)) {
            entering.set(id, { right, height })
            return
          }
          // Raised even when the camera waits: nothing may cover a sheet it frames.
          const before = revealed.current?.id
          revealed.current = { id, selected: selectedNow.current }
          const top = stacking.current.length
          setNodes((previous) =>
            previous.map((other) =>
              other.id === id
                ? { ...other, zIndex: top }
                : other.id === before
                  ? { ...other, zIndex: Math.max(0, stacking.current.indexOf(other.id)) }
                  : other,
            ),
          )
          // A sheet already open as Canvas mounts waits for the first camera, which fits it.
          if (entrySheets.current) {
            entrySheets.current.set(id, { right, height })
            return
          }
          const node = getNode(id)
          if (!node) return
          void fitBounds(
            {
              x: node.position.x,
              y: node.position.y,
              width: (node.measured?.width ?? node.width ?? 0) + right,
              height: Math.max(node.measured?.height ?? node.height ?? 0, height),
            },
            { padding: 0.08, duration: 240 },
          )
        },
      })
    },
    [fitBounds, flyTo, getNode, legible, render, setNodes, terminals],
  )

  // The canvas places its windows: where this stay has them, as its windows, their teams
  // and the sidebar's order change. Parent updates refresh terminal content and selection
  // while a drag in progress stays XYFlow's.
  useEffect(() => {
    if (!stay.current || !opened) return
    const afresh = arrangedFor.current !== reordered
    arrangedFor.current = reordered
    let next = afresh ? beginStay(tiles, room()) : continueStay(stay.current, tiles)
    const terminalIds = new Set(terminals.map((terminal) => terminal.id))
    for (const id of drops.keys()) if (!terminalIds.has(id)) drops.delete(id)
    // A window dropped from a taskbar where the ghost was opens exactly there, then settles
    // onto the place it was given.
    const settling = new Map<string, XYPosition>()
    for (const terminal of terminals) {
      const saved = layout.geometry[terminal.id]
      if (!saved || drops.get(terminal.id) === saved) continue
      drops.set(terminal.id, saved)
      const dropped = saved.position
      next = moveInStay(next, terminal.id, dropped)
      if (
        isWindow(terminal) &&
        !knownTerminals.current.has(terminal.id) &&
        lastGhost.current &&
        samePoint(canvasPointPosition(lastGhost.current), dropped)
      ) {
        settling.set(terminal.id, lastGhost.current)
        lastGhost.current = null
      }
    }
    stay.current = next
    const arranged = stayPlaces(next)
    // A hidden terminal looked at is shown where it would go if it were shown, unless this
    // stay still has the place it had. Only its own place is taken from that: the stay
    // keeps nothing of it, and no other window moves for it.
    const shown =
      preview && !arranged.has(preview)
        ? stayPlaces(continueStay(next, [...tiles, { id: preview }])).get(preview)
        : undefined
    const places = shown ? new Map(arranged).set(preview, shown) : arranged
    // A window that opened is revealed where the canvas put it, if that is out of sight.
    for (const terminal of terminals) {
      if (knownTerminals.current.has(terminal.id)) continue
      knownTerminals.current.add(terminal.id)
      const place = places.get(terminal.id)
      if (place) createdPositions.current.set(terminal.id, place)
    }
    for (const id of knownTerminals.current) {
      if (!terminalIds.has(id)) {
        knownTerminals.current.delete(id)
        createdPositions.current.delete(id)
        dragging.current.delete(id)
      }
    }
    // Keep activation history instead of temporarily elevating only the selected node.
    const order = stacking.current.filter((id) => terminalIds.has(id))
    const known = new Set(order)
    const stack = [
      ...order,
      ...terminals.filter((terminal) => !known.has(terminal.id)).map((terminal) => terminal.id),
    ].filter((id) => id !== selected)
    if (terminalIds.has(selected)) stack.push(selected)
    stacking.current = stack
    if (revealed.current && revealed.current.selected !== selected) revealed.current = null
    const above = revealed.current?.id
    const levels = new Map(stack.map((id, index) => [id, index]))
    if (above && levels.has(above)) levels.set(above, stack.length)
    // Windows the arrangement moves glide there; the team wires wait for them (canvas.css).
    const moves = terminals.some((terminal) => {
      const current = getNode(terminal.id)
      return (
        current !== undefined &&
        !dragging.current.has(terminal.id) &&
        !samePoint(current.position, places.get(terminal.id) ?? origin)
      )
    })
    if (moves && container.current) {
      const element = container.current
      element.dataset.arranging = ""
      clearTimeout(arranging.current)
      arranging.current = setTimeout(() => delete element.dataset.arranging, glideMs + 40)
    }
    // The camera goes with the selected window when the arrangement moves it while it is
    // in sight, so the person keeps what they were looking at. A reorder moves them all,
    // and the camera stays.
    const was = getNode(selected)?.position
    const now = places.get(selected)
    if (!afresh && was && now && !samePoint(was, now) && !dragging.current.has(selected)) {
      const viewport = getViewport()
      if (inSight(was, viewport, viewportSize()))
        void setViewport(
          {
            x: viewport.x - (now.x - was.x) * viewport.zoom,
            y: viewport.y - (now.y - was.y) * viewport.zoom,
            zoom: viewport.zoom,
          },
          { duration: prefersReducedMotion() ? 0 : glideMs },
        )
    }
    setNodes((previous) => {
      const existing = new Map(previous.map((node) => [node.id, node]))
      return terminals.map((terminal) => {
        const placed = {
          ...nodeFrom(terminal, settling.get(terminal.id) ?? places.get(terminal.id)),
          zIndex: levels.get(terminal.id) ?? 0,
        }
        const current = existing.get(terminal.id)
        if (!current) return placed
        const positioned = dragging.current.has(terminal.id)
          ? { ...placed, position: current.position }
          : placed
        return current.className ? { ...positioned, className: current.className } : positioned
      })
    })
    // A window dropped from a taskbar glides onto the grid from where its ghost was.
    for (const id of settling.keys()) {
      const snapped = places.get(id)
      if (!snapped) continue
      requestAnimationFrame(() => {
        updateNode(id, (node) => ({ ...node, position: snapped, className: "canvas-drop-settle" }))
        setTimeout(() => updateNode(id, (node) => ({ ...node, className: "" })), settleMs)
      })
    }
  }, [
    drops,
    getNode,
    getViewport,
    layout.geometry,
    nodeFrom,
    opened,
    preview,
    reordered,
    room,
    selected,
    setNodes,
    setViewport,
    terminals,
    tiles,
    updateNode,
    viewportSize,
  ])

  const canvas = (
    <div
      data-workspace-viewport
      className="canvas-viewport relative min-h-0 flex-1 overflow-clip touch-none workspace-background"
      ref={container}
      style={
        {
          "--_canvas-header-height": `${terminalHeaderHeight}px`,
        } as CSSProperties
      }
      aria-label="Terminal canvas"
      data-has-selection={Boolean(selected)}
      tabIndex={0}
      {...backgroundPointerHandlers}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 ||
          event.repeat ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          !workspaceShortcutTarget(event.target) ||
          workspaceOverlayOpen()
        )
          return
        if (event.key === "+" || (event.key === "=" && !event.shiftKey)) {
          event.preventDefault()
          visit.clear()
          void zoomIn()
        }
        if (event.key === "-" && !event.shiftKey) {
          event.preventDefault()
          visit.clear()
          void zoomOut()
        }
        if (event.key === "0" && !event.shiftKey) {
          event.preventDefault()
          fitAll()
        }
      }}
    >
      <NodeVisibilityContext.Provider value={visibility}>
        <TerminalContent.Provider value={contentOf}>
          {opened && (
            <ReactFlow<TerminalNode>
              defaultNodes={terminals.map((terminal) =>
                nodeFrom(terminal, opened.get(terminal.id)),
              )}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onNodeClick={(_, node) => onSelect(node.id)}
              onPaneClick={(event) => {
                onSelect("")
                event.currentTarget
                  .closest<HTMLElement>(".canvas-viewport")
                  ?.focus({ preventScroll: true })
              }}
              elevateNodesOnSelect={false}
              nodesConnectable={false}
              deleteKeyCode={null}
              multiSelectionKeyCode={null}
              selectionKeyCode={null}
              disableKeyboardA11y
              minZoom={0.15}
              maxZoom={maxZoom}
              defaultViewport={initialViewport ?? { x: 0, y: 0, zoom: 1 }}
              onInit={initializeViewport}
              onMoveStart={(_, viewport) => {
                lastViewport.current = viewport
              }}
              onMove={(event, viewport) => {
                const previous = lastViewport.current
                if (
                  event &&
                  (viewport.x !== previous.x ||
                    viewport.y !== previous.y ||
                    viewport.zoom !== previous.zoom)
                )
                  visit.clear()
                lastViewport.current = viewport
              }}
              panOnDrag
              panOnScroll={false}
              zoomOnScroll
              zoomOnDoubleClick={false}
              zoomActivationKeyCode={["Control", "Meta"]}
              proOptions={{ hideAttribution: true }}
            >
              <Background
                id="grid"
                className="canvas-grid"
                gap={canvasStep}
                size={1.6}
                bgColor="transparent"
              />
              <Background
                id="grid-spotlight"
                className="canvas-grid-spotlight"
                gap={canvasStep}
                size={1.6}
                bgColor="transparent"
              />
              <CanvasTeamWire teams={teams} team={team} selected={selected} />
              {ghost && (
                <ViewportPortal>
                  <div
                    className="drop-ghost canvas-drop-ghost"
                    aria-hidden="true"
                    style={{
                      transform: `translate(${ghost.x}px, ${ghost.y}px)`,
                      width: windowSize.width,
                      height: windowSize.height,
                    }}
                  >
                    <span className="drop-ghost-header">{ghostName}</span>
                  </div>
                </ViewportPortal>
              )}
            </ReactFlow>
          )}
        </TerminalContent.Provider>
      </NodeVisibilityContext.Provider>
    </div>
  )
  return canvas
}

export const Canvas = forwardRef<CanvasHandle, CanvasProps>((props, ref) => (
  <ReactFlowProvider>
    <TerminalCanvas {...props} handleRef={ref} />
  </ReactFlowProvider>
))
