import {
  Background,
  getNodesBounds,
  getViewportForBounds,
  NodeResizeControl,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type Node,
  type NodeProps,
  type OnNodesChange,
  type XYPosition,
} from "@xyflow/react"
import { Plus } from "lucide-react"
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type CSSProperties,
  type Ref,
  type ReactNode,
} from "react"

import { ContextMenu } from "../../ui-toolkit/ContextMenu"
import type { SizePreset, Session, CanvasLayout } from "../model/types"
import { workspaceOverlayOpen, workspaceShortcutTarget } from "../shortcuts"
import type { MinimizeControls } from "../terminals/Terminal"
import { backgroundPointerHandlers } from "./background"
import { canvasPointPosition, viewportCanvasPosition } from "./canvas-placement"
import { createCanvasVisit } from "./canvas-visit"
import { canvasNewTerminalSize, canvasPresetSize } from "./terminal-size"
import { useTerminalVisibility } from "./useTerminalVisibility"

type TerminalNode = Node<
  {
    compactHeader: boolean
    minimized: boolean
    hiding: boolean
    preview: boolean
    focusRequest: number | null
    onResizeStart: () => void
    onResizeEnd: (width: number, height: number) => void
  },
  "terminal"
>
type CanvasProps = {
  presets: Record<string, SizePreset>
  onPresetChange: (id: string, preset: SizePreset) => void
  layout: CanvasLayout
  matchCreatedTerminalRatio: boolean
  revealOnMount: boolean
  fitOnNavigate: boolean
  onLayoutChange: Dispatch<SetStateAction<CanvasLayout>>
  sessions: Session[]
  hidden: Record<string, boolean>
  preview: string
  selected: string
  keyboardFocusRequest: number | null
  navigation: number
  onSelect: (id: string) => void
  onCreate: () => string
  render: (
    session: Session,
    minimize: MinimizeControls,
    onFlyTo: () => void,
    resize: () => void,
  ) => ReactNode
}
type CanvasViewport = NonNullable<CanvasLayout["viewport"]>
export type CanvasHandle = {
  returnToOrigin: () => boolean
}
type TerminalCanvasProps = CanvasProps & { handleRef: Ref<CanvasHandle> }

// Terminal content comes from the canvas's current render, not from node data: node data
// reaches XYFlow a commit later, which would briefly show controlled inputs stale values.
const TerminalContent = createContext<(id: string) => ReactNode>(() => null)

const TerminalNodeView = ({ id, data, selected }: NodeProps<TerminalNode>): React.JSX.Element => {
  const contentOf = useContext(TerminalContent)
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (data.focusRequest === null) return
    content.current?.closest<HTMLElement>(".react-flow__node")?.focus({ preventScroll: true })
  }, [data.focusRequest])
  return (
    <div
      ref={content}
      data-node={id}
      data-preview={data.preview}
      inert={data.hiding}
      aria-hidden={data.hiding}
      className={`canvas-node h-full w-full ${selected ? "selected" : ""} ${data.compactHeader ? "compact-header" : ""} ${data.minimized ? "minimized" : ""}`}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div className="terminal-visibility relative h-full w-full" data-hiding={data.hiding}>
        <NodeResizeControl
          position="bottom-right"
          minWidth={320}
          minHeight={data.minimized ? 0 : 200}
          {...(data.minimized ? { resizeDirection: "horizontal" as const } : {})}
          autoScale={false}
          className="terminal-resize-grip nodrag nopan"
          onResizeStart={data.onResizeStart}
          onResizeEnd={(_, { width, height }) => data.onResizeEnd(width, height)}
        >
          <span className="terminal-resize-pattern" title="Resize" />
        </NodeResizeControl>
        {contentOf(id)}
      </div>
    </div>
  )
}
const nodeTypes = { terminal: TerminalNodeView }
const fitOptions = { padding: 0.08, maxZoom: 1 }
const canvasStep = 24
const snap = (value: number): number => Math.round(value / canvasStep) * canvasStep
const terminalHeaderHeight = 52
// Apply half the canvas zoom strength to node headers and resize grips.
const chromeScaleAt = (zoom: number): number => 1 / Math.sqrt(zoom)
const centerOf = (node: TerminalNode, zoom: number): XYPosition => ({
  x: node.position.x + (node.width ?? 550) / 2,
  y:
    node.position.y +
    (node.data.minimized ? terminalHeaderHeight * chromeScaleAt(zoom) + 2 : (node.height ?? 400)) /
      2,
})

const TerminalCanvas = ({
  presets,
  onPresetChange,
  layout,
  matchCreatedTerminalRatio,
  revealOnMount,
  fitOnNavigate,
  onLayoutChange,
  sessions,
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
    zoomIn,
    zoomOut,
    getViewport,
    setViewport,
    setCenter,
    getNode,
    setNodes,
    screenToFlowPosition,
  } = useReactFlow<TerminalNode>()
  const zoom = useStore((state) => state.transform[2])
  const viewportWidth = useStore((state) => state.width)
  const viewportHeight = useStore((state) => state.height)
  const maxZoom = Math.max(
    1.5,
    layout.viewport?.zoom ?? 1,
    Math.min(viewportWidth / 320, viewportHeight / 200),
  )
  const chromeScale = chromeScaleAt(zoom)
  const initialized = useNodesInitialized()
  const container = useRef<HTMLDivElement>(null)
  const [initialViewport] = useState(layout.viewport)
  const [visit] = useState(createCanvasVisit)
  const geometryRef = useRef<CanvasLayout["geometry"]>({ ...layout.geometry })
  const dirtyGeometry = useRef(new Set<string>())
  const resizing = useRef(new Set<string>())
  const viewportRef = useRef<CanvasViewport>(layout.viewport ?? { x: 0, y: 0, zoom: 1 })
  const dirtyViewport = useRef(false)
  const mounted = useRef(false)
  const latest = useRef({ sessions, onLayoutChange })
  // Returning to Canvas restores its camera; only new sidebar requests should recenter it.
  const lastNavigation = useRef(layout.viewport ? navigation : 0)
  const knownSessions = useRef(new Set(sessions.map((session) => session.id)))
  const createdPositions = useRef(new Map<string, XYPosition>())
  const pointerCreated = useRef(new Set<string>())
  const pendingCreatedPositions = useRef(new Map<string, XYPosition>())
  const contextPosition = useRef<XYPosition | null>(null)
  const stacking = useRef<string[]>([])
  const fitAll = useCallback((): void => {
    visit.clear()
    void fitView({
      ...fitOptions,
      nodes: sessions
        .filter((session) => !hidden[session.id])
        .map((session) => ({ id: session.id })),
    })
  }, [fitView, sessions, hidden, visit])
  useEffect(() => {
    latest.current = { sessions, onLayoutChange }
  }, [onLayoutChange, sessions])

  const commitGeometry = useCallback((ids: Iterable<string>) => {
    const { onLayoutChange: commitLayout, sessions: liveSessions } = latest.current
    const snapshots = [...ids].flatMap((id) => {
      const snapshotGeometry = geometryRef.current[id]
      if (!snapshotGeometry) return []
      const { position, width, height } = snapshotGeometry
      return [
        [
          id,
          {
            position,
            ...(width === undefined ? {} : { width }),
            ...(height === undefined ? {} : { height }),
          },
        ] as const,
      ]
    })
    if (!snapshots.length) return
    for (const [id] of snapshots) dirtyGeometry.current.delete(id)
    const liveIds = new Set(liveSessions.map((session) => session.id))
    commitLayout((previous) => {
      const nextGeometry = { ...previous.geometry }
      for (const [id, next] of snapshots) {
        if (!liveIds.has(id)) continue
        nextGeometry[id] = next
      }
      return { ...previous, geometry: nextGeometry }
    })
  }, [])

  const trackViewport = useCallback((viewport: CanvasViewport) => {
    viewportRef.current = { ...viewport }
    dirtyViewport.current = true
  }, [])

  const commitViewport = useCallback(() => {
    if (!dirtyViewport.current) return
    const { onLayoutChange: commitLayout } = latest.current
    const viewport = { ...viewportRef.current }
    dirtyViewport.current = false
    commitLayout((previous) =>
      previous.viewport?.x === viewport.x &&
      previous.viewport.y === viewport.y &&
      previous.viewport.zoom === viewport.zoom
        ? previous
        : { ...previous, viewport },
    )
  }, [])

  const updateNode = useCallback(
    (id: string, update: (node: TerminalNode) => TerminalNode) => {
      setNodes((nodes) => nodes.map((item) => (item.id === id ? update(item) : item)))
    },
    [setNodes],
  )

  const beginResize = useCallback(
    (id: string) => {
      resizing.current.add(id)
      const currentNode = getNode(id)
      if (currentNode) {
        geometryRef.current[id] = {
          ...geometryRef.current[id],
          position: currentNode.position,
          ...(currentNode.width ? { width: currentNode.width } : {}),
          ...(!currentNode.data.minimized && currentNode.height
            ? { height: currentNode.height }
            : {}),
        }
      }
      updateNode(id, (node) => ({ ...node, className: "resizing" }))
    },
    [getNode, updateNode],
  )

  const finishResize = useCallback(
    (id: string, width: number, height: number) => {
      if (!resizing.current.has(id)) return
      const currentNode = getNode(id)
      if (!currentNode) return
      resizing.current.delete(id)
      const isMinimized = currentNode.data.minimized
      const next = {
        ...geometryRef.current[id],
        position: currentNode.position,
        width: Math.max(336, snap(width)),
        ...(!isMinimized ? { height: Math.max(216, snap(height)) } : {}),
      }
      geometryRef.current[id] = next
      dirtyGeometry.current.add(id)
      updateNode(id, (current) => ({
        ...current,
        width: next.width,
        ...(!isMinimized ? { height: next.height } : {}),
        className: "",
      }))
      commitGeometry([id])
    },
    [commitGeometry, getNode, updateNode],
  )

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

  const animateVisit = useCallback(
    (flight: { viewport: CanvasViewport }) => {
      const run = (current: { viewport: CanvasViewport }): void => {
        void setViewport(current.viewport, {
          duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 350,
        }).then(
          (completed) => {
            const next = visit.finish(current, completed)
            if (next) run(next)
          },
          () => visit.finish(current, false),
        )
      }
      run(flight)
    },
    [setViewport, visit],
  )

  useImperativeHandle(
    handleRef,
    () => ({
      returnToOrigin: () => {
        if (!visit.visiting) return false
        const flight = visit.back()
        if (flight) animateVisit(flight)
        return true
      },
    }),
    [animateVisit, visit],
  )

  const flyTo = useCallback(
    (session: Session) => {
      if (visit.flying) return
      const node = getNode(session.id)
      if (!node) return
      onSelect(session.id)
      if (node.data.minimized) {
        onLayoutChange((previous) => ({
          ...previous,
          minimized: { ...previous.minimized, [session.id]: false },
        }))
      }
      if (!viewportWidth || !viewportHeight) return
      const viewport = getViewportForBounds(
        {
          ...node.position,
          width: node.width ?? 550,
          height: node.data.minimized
            ? (geometry[session.id]?.height ?? session.height)
            : (node.height ?? session.height),
        },
        viewportWidth,
        viewportHeight,
        0,
        Infinity,
        0,
      )
      const flight = visit.begin(session.id, getViewport(), viewport)
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
    (session: Session, source: CanvasLayout["geometry"][string] | undefined): TerminalNode => {
      const isMinimized = minimized[session.id] ?? false
      const width = source?.width ?? 550
      return {
        id: session.id,
        type: "terminal",
        hidden: removed[session.id] ?? false,
        position: source?.position ?? { x: session.x, y: session.y },
        width,
        height: isMinimized
          ? terminalHeaderHeight * chromeScale + 2
          : Math.max(source?.height ?? session.height, (terminalHeaderHeight + 4) * chromeScale),
        dragHandle: ".terminal-header",
        draggable: selected === session.id && !hidden[session.id],
        selectable: !hidden[session.id],
        focusable: !hidden[session.id],
        selected: selected === session.id,
        ariaLabel: `${session.name} terminal`,
        data: {
          preview: preview === session.id,
          focusRequest: selected === session.id ? keyboardFocusRequest : null,
          hiding: hidden[session.id] ?? false,
          compactHeader: width / chromeScale < 240,
          minimized: isMinimized,
          onResizeStart: () => beginResize(session.id),
          onResizeEnd: (nextWidth, nextHeight) => finishResize(session.id, nextWidth, nextHeight),
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
      const session = sessions.find((item) => item.id === id)
      if (!session) return null
      return render(
        session,
        {
          minimized: minimized[id] ?? false,
          onToggle: () =>
            onLayoutChange((previous) => ({
              ...previous,
              minimized: { ...previous.minimized, [id]: !previous.minimized[id] },
            })),
        },
        () => flyTo(session),
        () => resizeToViewport(id),
      )
    },
    [flyTo, minimized, onLayoutChange, render, resizeToViewport, sessions],
  )

  // XYFlow owns pointer-time geometry so dragging does not rerender the application or terminals.
  // Parent updates refresh terminal content and selection while retaining any in-progress gesture.
  useEffect(() => {
    const sessionIds = new Set(sessions.map((session) => session.id))
    for (const id of Object.keys(geometryRef.current)) {
      if (!sessionIds.has(id)) {
        delete geometryRef.current[id]
        dirtyGeometry.current.delete(id)
        resizing.current.delete(id)
      }
    }
    for (const session of sessions) {
      if (!dirtyGeometry.current.has(session.id))
        geometryRef.current[session.id] = geometry[session.id] ?? {
          position: { x: session.x, y: session.y },
        }
    }
    const created = sessions.filter((session) => !knownSessions.current.has(session.id))
    if (created.length && viewportWidth && viewportHeight) {
      const viewport = getViewport()
      const occupied = sessions
        .filter((session) => knownSessions.current.has(session.id))
        .map((session) => {
          const saved = geometryRef.current[session.id]
          const live = getNode(session.id)
          return {
            position: live?.position ?? saved?.position ?? { x: session.x, y: session.y },
            width: live?.width ?? saved?.width ?? 550,
            height: saved?.height ?? session.height,
          }
        })
      for (const session of created) {
        const saved = geometryRef.current[session.id]
        const size = canvasNewTerminalSize(
          { width: viewportWidth, height: viewportHeight },
          matchCreatedTerminalRatio,
          { width: saved?.width ?? 600, height: saved?.height ?? session.height },
        )
        const requested = pendingCreatedPositions.current.get(session.id)
        const position = requested
          ? canvasPointPosition(requested)
          : viewportCanvasPosition(
              occupied,
              viewport,
              { width: viewportWidth, height: viewportHeight },
              size,
            )
        geometryRef.current[session.id] = { ...saved, position, ...size }
        dirtyGeometry.current.add(session.id)
        if (requested) {
          pendingCreatedPositions.current.delete(session.id)
          pointerCreated.current.add(session.id)
        } else createdPositions.current.set(session.id, position)
        knownSessions.current.add(session.id)
        occupied.push({ position, ...size })
      }
      commitGeometry(created.map((session) => session.id))
    }
    for (const id of knownSessions.current) {
      if (!sessionIds.has(id)) {
        knownSessions.current.delete(id)
        createdPositions.current.delete(id)
      }
    }
    // Keep activation history instead of temporarily elevating only the selected node.
    const order = stacking.current.filter((id) => sessionIds.has(id))
    const known = new Set(order)
    const stack = [
      ...order,
      ...sessions.filter((session) => !known.has(session.id)).map((session) => session.id),
    ].filter((id) => id !== selected)
    if (sessionIds.has(selected)) stack.push(selected)
    stacking.current = stack
    const levels = new Map(stack.map((id, index) => [id, index]))
    setNodes((previous) => {
      const existing = new Map(previous.map((node) => [node.id, node]))
      return sessions.map((session) => {
        const next = {
          ...nodeFrom(session, geometryRef.current[session.id]),
          zIndex: levels.get(session.id) ?? 0,
        }
        const current = existing.get(session.id)
        if (!current || !dirtyGeometry.current.has(session.id)) return next
        const retained = {
          ...next,
          position: current.position,
          width: current.width ?? next.width ?? 550,
          height: current.height ?? next.height ?? session.height,
        }
        return current.className ? { ...retained, className: current.className } : retained
      })
    })
  }, [
    commitGeometry,
    geometry,
    getNode,
    getViewport,
    matchCreatedTerminalRatio,
    nodeFrom,
    selected,
    sessions,
    setNodes,
    viewportHeight,
    viewportWidth,
  ])

  useEffect(() => {
    if (!dirtyViewport.current && layout.viewport) viewportRef.current = { ...layout.viewport }
  }, [layout.viewport])

  useEffect(
    () => () => {
      const ids = [...dirtyGeometry.current]
      for (const id of ids) {
        const current = geometryRef.current[id]
        if (!current) continue
        const isResizing = resizing.current.has(id)
        const isMinimized = getNode(id)?.data.minimized ?? false
        geometryRef.current[id] = {
          ...current,
          position: { x: snap(current.position.x), y: snap(current.position.y) },
          ...(isResizing && current.width ? { width: Math.max(336, snap(current.width)) } : {}),
          ...(isResizing && !isMinimized && current.height
            ? { height: Math.max(216, snap(current.height)) }
            : {}),
        }
      }
      resizing.current.clear()
      commitGeometry(ids)
      if (dirtyViewport.current) {
        trackViewport(getViewport())
        commitViewport()
      }
    },
    [commitGeometry, commitViewport, getNode, getViewport, trackViewport],
  )

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const onNodesChange: OnNodesChange<TerminalNode> = useCallback(
    (changes) => {
      for (const change of changes) {
        if (change.type === "position" && change.position && !resizing.current.has(change.id)) {
          if (change.dragging) {
            geometryRef.current[change.id] = {
              ...geometryRef.current[change.id],
              position: change.position,
            }
            dirtyGeometry.current.add(change.id)
          } else if (dirtyGeometry.current.has(change.id)) {
            const position = { x: snap(change.position.x), y: snap(change.position.y) }
            geometryRef.current[change.id] = { ...geometryRef.current[change.id], position }
            updateNode(change.id, (node) => ({ ...node, position }))
            commitGeometry([change.id])
          }
        }
        if (change.type === "dimensions" && change.dimensions && resizing.current.has(change.id)) {
          const current = geometryRef.current[change.id]
          const isMinimized = getNode(change.id)?.data.minimized ?? false
          geometryRef.current[change.id] = {
            ...current,
            position: current?.position ?? getNode(change.id)?.position ?? { x: 0, y: 0 },
            width: change.dimensions.width,
            ...(!isMinimized ? { height: change.dimensions.height } : {}),
          }
          dirtyGeometry.current.add(change.id)
          if (change.resizing === false)
            finishResize(change.id, change.dimensions.width, change.dimensions.height)
        }
        if (change.type === "select" && change.selected) onSelect(change.id)
      }
    },
    [commitGeometry, finishResize, getNode, onSelect, updateNode],
  )

  useEffect(() => {
    if (
      !initialized ||
      navigation === lastNavigation.current ||
      hidden[selected] ||
      !getNode(selected)
    )
      return
    const node = getNode(selected)
    if (!node || node.hidden) return
    lastNavigation.current = navigation
    visit.clear()
    const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180
    if (pointerCreated.current.delete(selected)) return
    const created = createdPositions.current.get(selected)
    if (created) {
      createdPositions.current.delete(selected)
      const viewport = getViewport()
      const size = geometryRef.current[selected]
      const width = size?.width ?? node.width ?? 600
      const height = size?.height ?? node.height ?? 400
      const margin = 24 / viewport.zoom
      const left = -viewport.x / viewport.zoom
      const top = -viewport.y / viewport.zoom
      const right = (viewportWidth - viewport.x) / viewport.zoom
      const bottom = (viewportHeight - viewport.y) / viewport.zoom
      if (
        created.x >= left + margin &&
        created.y >= top + margin &&
        created.x + width <= right - margin &&
        created.y + height <= bottom - margin
      )
        return
      void setCenter(created.x + width / 2, created.y + height / 2, {
        zoom: viewport.zoom,
        duration,
        interpolate: "linear",
      })
      return
    }
    if (fitOnNavigate) {
      void fitView({
        ...fitOptions,
        nodes: [{ id: selected }],
        maxZoom: 1.5,
        duration,
      })
      return
    }
    const targetZoom = getViewport().zoom
    const center = centerOf(node, targetZoom)
    void setCenter(center.x, center.y, { zoom: targetZoom, duration, interpolate: "linear" })
  }, [
    initialized,
    navigation,
    selected,
    hidden,
    fitOnNavigate,
    fitView,
    getNode,
    getViewport,
    setCenter,
    visit,
    viewportHeight,
    viewportWidth,
  ])

  const canvas = (
    <div
      className="canvas-viewport relative min-h-0 flex-1 overflow-hidden bg-canvas touch-none workspace-background"
      ref={container}
      style={
        {
          "--canvas-chrome-scale": chromeScale,
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
          defaultNodes={sessions.map((session) => nodeFrom(session, geometry[session.id]))}
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
          onInit={(instance) => {
            if (!container.current || (initialViewport && !revealOnMount)) return
            const selectedNode = navigation ? instance.getNode(selected) : undefined
            const target = selectedNode?.hidden ? undefined : selectedNode
            if (initialViewport && target && !fitOnNavigate) {
              const center = centerOf(target, initialViewport.zoom)
              lastNavigation.current = navigation
              void instance.setCenter(center.x, center.y, { zoom: initialViewport.zoom })
              return
            }
            const visible = instance.getNodes().filter((node) => !node.hidden)
            if (!visible.length) return
            const bounds = getNodesBounds(target ? [target] : visible)
            lastNavigation.current = navigation
            // Compute the first camera before a view-transition snapshot, without waiting for paint.
            void instance.setViewport(
              getViewportForBounds(
                bounds,
                container.current.clientWidth,
                container.current.clientHeight,
                0.15,
                target && fitOnNavigate ? 1.5 : fitOptions.maxZoom,
                fitOptions.padding,
              ),
            )
          }}
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
