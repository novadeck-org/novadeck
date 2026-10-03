import "./canvas.css"
import {
  Background,
  getViewportForBounds,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  ViewportPortal,
  useStoreApi,
  type ReactFlowState,
  type XYPosition,
} from "@xyflow/react"
import { Plus } from "lucide-react"
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"

import { workspaceOverlayOpen, workspaceShortcutTarget } from "../../interaction/shortcuts"
import { canvasPointPosition, viewportCanvasPosition } from "../../model/layout/canvas-placement"
import { canvasNewTerminalSize, canvasPresetSize } from "../../model/layout/terminal-size"
import { isWindow } from "../../model/roster"
import type { Tile, CanvasLayout } from "../../model/types"
import { useDrag, useDragSession } from "../../terminals/drag-session"
import { ContextMenu } from "../../ui-toolkit/ContextMenu"
import { backgroundPointerHandlers } from "../background"
import { useTerminalVisibility } from "../useTerminalVisibility"
import { fitOptions, canvasStep, terminalHeaderHeight, chromeScaleAt, centerOf } from "./geometry"
import { TerminalContent, nodeTypes } from "./TerminalNode"
import type { CanvasProps, CanvasHandle, TerminalCanvasProps, TerminalNode } from "./types"
import { useCanvasGeometry } from "./useCanvasGeometry"
import { useCanvasNavigation } from "./useCanvasNavigation"
import { useCanvasPersistence } from "./useCanvasPersistence"
import { useCanvasVisit } from "./useCanvasVisit"
export type { CanvasHandle } from "./types"

// The chrome that reads `--canvas-chrome-scale` (canvas.css, runner.css).
const chromeReaders = ".terminal-heading, .terminal-resize-grip, .runner-ending"

// How long a window dropped from a taskbar takes to settle onto the canvas's grid.
const settleMs = 160

const samePoint = (a: XYPosition, b: XYPosition): boolean => a.x === b.x && a.y === b.y

const TerminalCanvas = ({
  presets,
  onPresetChange,
  layout,
  matchCreatedTerminalRatio,
  revealOnMount,
  fitOnNavigate,
  onLayoutChange,
  terminals,
  hidden,
  preview,
  selected,
  keyboardFocusRequest,
  navigation,
  onSelect,
  onCreate,
  render,
  handleRef,
}: TerminalCanvasProps): React.JSX.Element => {
  const { minimized, geometry } = layout
  const removed = useTerminalVisibility(hidden)
  const {
    fitView,
    fitBounds,
    zoomIn,
    zoomOut,
    getViewport,
    getNode,
    setNodes,
    updateNode,
    screenToFlowPosition,
  } = useReactFlow<TerminalNode>()
  const store = useStoreApi<TerminalNode>()
  const viewportWidth = useStore((state) => state.width)
  const viewportHeight = useStore((state) => state.height)
  const maxZoom = Math.max(
    1.5,
    layout.viewport?.zoom ?? 1,
    Math.min(viewportWidth / 320, viewportHeight / 200),
  )
  const container = useRef<HTMLDivElement>(null)
  const [initialViewport] = useState(layout.viewport)
  const { visit, animateVisit } = useCanvasVisit(handleRef)
  const persistence = useCanvasPersistence({ layout, terminals, onLayoutChange })
  const {
    geometryRef,
    dirtyGeometry,
    resizing,
    viewportRef,
    mounted,
    commitGeometry,
    trackViewport,
    commitViewport,
  } = persistence
  // Zoom reaches the nodes only where it changes them: a header turning compact, and a
  // minimized terminal's height, which follows the header's scale. The chrome itself
  // scales in CSS (below), so zooming rerenders no terminal until one of those changes.
  useStore(
    useCallback(
      (state: ReactFlowState) => {
        const scale = chromeScaleAt(state.transform[2])
        const compact = terminals
          .map((terminal) =>
            (geometryRef.current[terminal.id]?.width ?? 550) / scale < 240 ? "1" : "0",
          )
          .join("")
        return terminals.some((terminal) => minimized[terminal.id])
          ? `${compact}:${scale}`
          : compact
      },
      [terminals, geometryRef, minimized],
    ),
  )
  const chromeScale = chromeScaleAt(store.getState().transform[2])
  // The chrome's scale is a CSS variable, but setting it on the canvas restyles everything
  // inside, thousands of terminal rows included, on every frame of a zoom. So a zoom sets
  // it only on the chrome that reads it, and the canvas takes it once the zoom rests, for
  // chrome that mounts afterwards.
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    let zoom = store.getState().transform[2]
    let resting: ReturnType<typeof setTimeout> | undefined
    element.style.setProperty("--canvas-chrome-scale", String(chromeScaleAt(zoom)))
    const unsubscribe = store.subscribe((state) => {
      if (state.transform[2] === zoom) return
      zoom = state.transform[2]
      const scale = String(chromeScaleAt(zoom))
      for (const chrome of element.querySelectorAll<HTMLElement>(chromeReaders))
        chrome.style.setProperty("--canvas-chrome-scale", scale)
      clearTimeout(resting)
      resting = setTimeout(() => element.style.setProperty("--canvas-chrome-scale", scale), 150)
    })
    return () => {
      unsubscribe()
      clearTimeout(resting)
    }
  }, [store])
  const knownTerminals = useRef(new Set(terminals.map((terminal) => terminal.id)))
  const createdPositions = useRef(new Map<string, XYPosition>())
  const pointerCreated = useRef(new Set<string>())
  const pendingCreatedPositions = useRef(new Map<string, XYPosition>())
  const contextPosition = useRef<XYPosition | null>(null)
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
        // Its window would open with its header under the pointer, at its usual size.
        const point = screenToFlowPosition({ x, y })
        const { width } = canvasPresetSize("small")
        return { canvas: { x: point.x - width / 2, y: point.y - terminalHeaderHeight / 2 } }
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
  const settling = useRef(new Map<string, XYPosition>())
  const stacking = useRef<string[]>([])
  const initializeViewport = useCanvasNavigation({
    navigation,
    selected,
    hidden,
    fitOnNavigate,
    revealOnMount,
    initialViewport,
    viewportWidth,
    viewportHeight,
    container,
    geometryRef,
    createdPositions,
    pointerCreated,
    visit,
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
  const { beginResize, finishResize, onNodesChange } = useCanvasGeometry(persistence, onSelect)

  const resizeToViewport = useCallback(
    (id: string) => {
      const node = getNode(id)
      if (!node || !viewportWidth || !viewportHeight) return
      const preset = presets[id] === "large" ? "small" : "large"
      const { width, height } = canvasPresetSize(preset, {
        width: viewportWidth,
        height: viewportHeight,
      })
      const center = centerOf(node, getViewport().zoom)
      const next = {
        position: { x: center.x - width / 2, y: center.y - height / 2 },
        width,
        height,
      }
      onLayoutChange((previous) => ({
        ...previous,
        geometry: { ...previous.geometry, [id]: next },
        minimized: { ...previous.minimized, [id]: false },
      }))
      onPresetChange(id, preset)
    },
    [getNode, getViewport, onLayoutChange, viewportWidth, viewportHeight, presets, onPresetChange],
  )

  const flyTo = useCallback(
    (terminal: Tile) => {
      if (visit.flying) return
      const node = getNode(terminal.id)
      if (!node) return
      onSelect(terminal.id)
      if (node.data.minimized) {
        onLayoutChange((previous) => ({
          ...previous,
          minimized: { ...previous.minimized, [terminal.id]: false },
        }))
      }
      if (!viewportWidth || !viewportHeight) return
      const viewport = getViewportForBounds(
        {
          ...node.position,
          width: node.width ?? 550,
          height: node.data.minimized
            ? (geometry[terminal.id]?.height ?? 400)
            : (node.height ?? 400),
        },
        viewportWidth,
        viewportHeight,
        0,
        Infinity,
        0,
      )
      const flight = visit.begin(terminal.id, getViewport(), viewport)
      if (!flight) return
      animateVisit(flight)
    },
    [
      animateVisit,
      geometry,
      getNode,
      getViewport,
      onLayoutChange,
      onSelect,
      viewportHeight,
      viewportWidth,
      visit,
    ],
  )

  const nodeFrom = useCallback(
    (terminal: Tile, source: CanvasLayout["geometry"][string] | undefined): TerminalNode => {
      const isMinimized = minimized[terminal.id] ?? false
      const width = source?.width ?? 550
      return {
        id: terminal.id,
        type: "terminal",
        hidden: removed[terminal.id] ?? false,
        position: source?.position ?? { x: 80, y: 80 },
        width,
        height: isMinimized
          ? terminalHeaderHeight * chromeScale + 2
          : Math.max(source?.height ?? 400, (terminalHeaderHeight + 4) * chromeScale),
        dragHandle: ".terminal-header",
        draggable: selected === terminal.id && !hidden[terminal.id],
        selectable: !hidden[terminal.id],
        focusable: !hidden[terminal.id],
        selected: selected === terminal.id,
        ariaLabel: `${terminal.name} terminal`,
        data: {
          preview: preview === terminal.id,
          focusRequest: selected === terminal.id ? keyboardFocusRequest : null,
          hiding: hidden[terminal.id] ?? false,
          compactHeader: width / chromeScale < 240,
          minimized: isMinimized,
          onResizeStart: () => beginResize(terminal.id),
          onResizeEnd: (nextWidth, nextHeight) => finishResize(terminal.id, nextWidth, nextHeight),
        },
      }
    },
    [
      beginResize,
      chromeScale,
      finishResize,
      hidden,
      preview,
      removed,
      minimized,
      selected,
      keyboardFocusRequest,
    ],
  )

  const contentOf = useCallback(
    (id: string): ReactNode => {
      const terminal = terminals.find((item) => item.id === id)
      if (!terminal) return null
      return render(terminal, {
        minimize: {
          minimized: minimized[id] ?? false,
          onToggle: () =>
            onLayoutChange((previous) => ({
              ...previous,
              minimized: { ...previous.minimized, [id]: !previous.minimized[id] },
            })),
        },
        onFlyTo: () => flyTo(terminal),
        onResizePreset: () => resizeToViewport(id),
        onReveal: ({ right, height }) => {
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
    [fitBounds, flyTo, getNode, minimized, onLayoutChange, render, resizeToViewport, terminals],
  )

  // XYFlow owns pointer-time geometry so dragging does not rerender the application or terminals.
  // Parent updates refresh terminal content and selection while retaining any in-progress gesture.
  useEffect(() => {
    const terminalIds = new Set(terminals.map((terminal) => terminal.id))
    for (const id of Object.keys(geometryRef.current)) {
      if (!terminalIds.has(id)) {
        delete geometryRef.current[id]
        dirtyGeometry.current.delete(id)
        resizing.current.delete(id)
      }
    }
    for (const terminal of terminals) {
      if (!dirtyGeometry.current.has(terminal.id))
        geometryRef.current[terminal.id] = geometry[terminal.id] ?? {
          position: { x: 80, y: 80 },
        }
    }
    const created = terminals.filter((terminal) => !knownTerminals.current.has(terminal.id))
    if (created.length && viewportWidth && viewportHeight) {
      const viewport = getViewport()
      const occupied = terminals
        .filter((terminal) => knownTerminals.current.has(terminal.id))
        .map((terminal) => {
          const saved = geometryRef.current[terminal.id]
          const live = getNode(terminal.id)
          return {
            position: live?.position ?? saved?.position ?? { x: 80, y: 80 },
            width: live?.width ?? saved?.width ?? 550,
            height: saved?.height ?? 400,
          }
        })
      for (const terminal of created) {
        const saved = geometryRef.current[terminal.id]
        const size = canvasNewTerminalSize(
          { width: viewportWidth, height: viewportHeight },
          matchCreatedTerminalRatio,
          { width: saved?.width ?? 600, height: saved?.height ?? 400 },
        )
        // Dropped from a taskbar where the ghost was, its window opens exactly there, then
        // settles onto the place it was given.
        const ghostAt =
          isWindow(terminal) &&
          lastGhost.current &&
          saved?.position &&
          samePoint(canvasPointPosition(lastGhost.current), saved.position)
            ? lastGhost.current
            : null
        if (ghostAt) {
          settling.current.set(terminal.id, saved!.position)
          lastGhost.current = null
        }
        const requested = pendingCreatedPositions.current.get(terminal.id)
        const position = ghostAt
          ? ghostAt
          : requested
            ? canvasPointPosition(requested)
            : viewportCanvasPosition(
                occupied,
                viewport,
                { width: viewportWidth, height: viewportHeight },
                size,
              )
        geometryRef.current[terminal.id] = { ...saved, position, ...size }
        dirtyGeometry.current.add(terminal.id)
        if (requested) {
          pendingCreatedPositions.current.delete(terminal.id)
          pointerCreated.current.add(terminal.id)
        } else createdPositions.current.set(terminal.id, position)
        knownTerminals.current.add(terminal.id)
        occupied.push({ position, ...size })
      }
      commitGeometry(created.map((terminal) => terminal.id))
      // A window dropped from a taskbar glides onto the grid from where its ghost was.
      for (const terminal of created) {
        const snapped = settling.current.get(terminal.id)
        if (!snapped) continue
        settling.current.delete(terminal.id)
        requestAnimationFrame(() => {
          geometryRef.current[terminal.id] = {
            ...geometryRef.current[terminal.id],
            position: snapped,
          }
          updateNode(terminal.id, (node) => ({
            ...node,
            position: snapped,
            className: "canvas-drop-settle",
          }))
          commitGeometry([terminal.id])
          setTimeout(
            () => updateNode(terminal.id, (node) => ({ ...node, className: "" })),
            settleMs,
          )
        })
      }
    }
    for (const id of knownTerminals.current) {
      if (!terminalIds.has(id)) {
        knownTerminals.current.delete(id)
        createdPositions.current.delete(id)
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
    const levels = new Map(stack.map((id, index) => [id, index]))
    setNodes((previous) => {
      const existing = new Map(previous.map((node) => [node.id, node]))
      return terminals.map((terminal) => {
        const next = {
          ...nodeFrom(terminal, geometryRef.current[terminal.id]),
          zIndex: levels.get(terminal.id) ?? 0,
        }
        const current = existing.get(terminal.id)
        if (!current || !dirtyGeometry.current.has(terminal.id)) return next
        const retained = {
          ...next,
          position: current.position,
          width: current.width ?? next.width ?? 550,
          height: current.height ?? next.height ?? 400,
        }
        return current.className ? { ...retained, className: current.className } : retained
      })
    })
  }, [
    commitGeometry,
    geometryRef,
    dirtyGeometry,
    resizing,
    geometry,
    getNode,
    getViewport,
    matchCreatedTerminalRatio,
    nodeFrom,
    selected,
    terminals,
    setNodes,
    updateNode,
    viewportHeight,
    viewportWidth,
  ])

  const canvas = (
    <div
      data-workspace-viewport
      className="canvas-viewport relative min-h-0 flex-1 overflow-hidden bg-canvas touch-none workspace-background"
      ref={container}
      style={
        {
          "--canvas-header-height": `${terminalHeaderHeight}px`,
        } as CSSProperties
      }
      aria-label="Terminal canvas"
      tabIndex={0}
      {...backgroundPointerHandlers}
      onContextMenu={(event) => {
        contextPosition.current = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      }}
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
      <TerminalContent.Provider value={contentOf}>
        <ReactFlow<TerminalNode>
          defaultNodes={terminals.map((terminal) => nodeFrom(terminal, geometry[terminal.id]))}
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
          onMoveStart={(_, viewport) => trackViewport(viewport)}
          onMove={(event, viewport) => {
            const previous = viewportRef.current
            if (
              event &&
              (viewport.x !== previous.x ||
                viewport.y !== previous.y ||
                viewport.zoom !== previous.zoom)
            )
              visit.clear()
            trackViewport(viewport)
          }}
          onMoveEnd={(_, viewport) => {
            const current = getViewport()
            if (
              !mounted.current ||
              current.x !== viewport.x ||
              current.y !== viewport.y ||
              current.zoom !== viewport.zoom
            )
              return
            trackViewport(viewport)
            commitViewport()
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
            color="var(--color-muted)"
            bgColor="transparent"
          />
          <Background
            id="grid-spotlight"
            className="canvas-grid-spotlight"
            gap={canvasStep}
            size={1.6}
            color="var(--color-muted)"
            bgColor="transparent"
          />
          {ghost && (
            <ViewportPortal>
              <div
                className="drop-ghost canvas-drop-ghost"
                aria-hidden="true"
                style={{
                  transform: `translate(${ghost.x}px, ${ghost.y}px)`,
                  ...canvasPresetSize("small"),
                }}
              >
                <span className="drop-ghost-header">{ghostName}</span>
              </div>
            </ViewportPortal>
          )}
        </ReactFlow>
      </TerminalContent.Provider>
    </div>
  )
  return (
    <ContextMenu
      label="Canvas actions"
      items={[
        {
          value: "terminal",
          label: "Terminal",
          icon: <Plus size={13} aria-hidden="true" />,
          onSelect: () => {
            if (!contextPosition.current) return
            const id = onCreate()
            pendingCreatedPositions.current.set(id, contextPosition.current)
          },
        },
      ]}
      trigger={canvas}
    />
  )
}

export const Canvas = forwardRef<CanvasHandle, CanvasProps>((props, ref) => {
  return (
    <ReactFlowProvider>
      <TerminalCanvas {...props} handleRef={ref} />
    </ReactFlowProvider>
  )
})
