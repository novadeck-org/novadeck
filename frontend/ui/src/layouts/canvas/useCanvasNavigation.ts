import type { CanvasLayout } from "@novadeck/core/types"
import {
  getNodesBounds,
  getViewportForBounds,
  useNodesInitialized,
  useReactFlow,
  type ReactFlowInstance,
  type XYPosition,
} from "@xyflow/react"
import { useEffect, useRef, type RefObject } from "react"

import { centerOf, fitOptions } from "./geometry"
import type { CanvasProps, CanvasViewport, TerminalNode } from "./types"
import type { createCanvasVisit } from "./visit"

type NavigationProps = Pick<
  CanvasProps,
  | "navigation"
  | "selected"
  | "hidden"
  | "fitOnNavigate"
  | "flyOnNavigate"
  | "revealOnMount"
  | "fitOnMount"
> & {
  initialViewport: CanvasViewport | undefined
  // Read when needed: it changes every frame while the sidebar slides.
  viewportSize: () => { width: number; height: number }
  container: RefObject<HTMLDivElement | null>
  geometryRef: RefObject<CanvasLayout["geometry"]>
  createdPositions: RefObject<Map<string, XYPosition>>
  pointerCreated: RefObject<Set<string>>
  visit: ReturnType<typeof createCanvasVisit>
  // Hands over the sheets open as Canvas mounts, by terminal, which the first camera also
  // has to fit; after that, a sheet opening frames itself.
  takeEntrySheets: () => Map<string, { right: number; height: number }>
  // Flies the camera in to a terminal, as `flyOnNavigate` asks.
  flyIn: (id: string) => void
}

// Sidebar navigation and new-terminal revelation preserve zoom unless fitting is requested.
export const useCanvasNavigation = ({
  navigation,
  selected,
  hidden,
  fitOnNavigate,
  flyOnNavigate,
  revealOnMount,
  fitOnMount,
  initialViewport,
  viewportSize,
  container,
  geometryRef,
  createdPositions,
  pointerCreated,
  visit,
  takeEntrySheets,
  flyIn,
}: NavigationProps) => {
  const { fitView, getNode, getViewport, setCenter } = useReactFlow<TerminalNode>()
  const initialized = useNodesInitialized()
  // Canvas sets its camera as it opens (below); only new sidebar requests recenter it. One
  // that flies is left for the windows to be measured, and flies from that camera.
  const lastNavigation = useRef(initialViewport && !flyOnNavigate ? navigation : 0)
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
    // A visit already at the terminal stays, so its way back is kept.
    if (flyOnNavigate) {
      pointerCreated.current.delete(selected)
      createdPositions.current.delete(selected)
      return flyIn(selected)
    }
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
      const { width: viewportWidth, height: viewportHeight } = viewportSize()
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
    const center = centerOf(node)
    void setCenter(center.x, center.y, { zoom: targetZoom, duration, interpolate: "linear" })
  }, [
    initialized,
    navigation,
    selected,
    hidden,
    fitOnNavigate,
    flyOnNavigate,
    flyIn,
    fitView,
    getNode,
    getViewport,
    setCenter,
    visit,
    viewportSize,
    geometryRef,
    pointerCreated,
    createdPositions,
  ])

  // Canvas opened from another view frames every visible window, however its camera was
  // left; a terminal opened into it is revealed instead. Otherwise, as on returning to a
  // session, it keeps the camera it was left with. A terminal gone to from outside the
  // canvas is flown in to from there, once its windows are measured (above).
  const initializeViewport = (instance: ReactFlowInstance<TerminalNode>) => {
    // Taken whichever camera this sets, or keeps: from here, a sheet opening frames itself.
    const sheets = takeEntrySheets()
    const framing = (fitOnMount && !revealOnMount) || flyOnNavigate
    if (!container.current || (initialViewport && !revealOnMount && !framing)) return
    if (initialViewport && flyOnNavigate) return
    const selectedNode = navigation && !framing ? instance.getNode(selected) : undefined
    const target = selectedNode?.hidden ? undefined : selectedNode
    if (initialViewport && target && !fitOnNavigate) {
      const center = centerOf(target)
      lastNavigation.current = navigation
      void instance.setCenter(center.x, center.y, { zoom: initialViewport.zoom })
      return
    }
    const visible = instance.getNodes().filter((node) => !node.hidden)
    if (!visible.length) return
    const bounds = getNodesBounds(target ? [target] : visible)
    // A terminal's open sheet hangs off its right edge: the camera takes it in with the node.
    for (const node of target ? [target] : visible) {
      const sheet = sheets.get(node.id)
      if (!sheet) continue
      const own = getNodesBounds([node])
      bounds.width = Math.max(bounds.width, own.x + own.width + sheet.right - bounds.x)
      bounds.height = Math.max(bounds.height, own.y + sheet.height - bounds.y)
    }
    if (!flyOnNavigate) lastNavigation.current = navigation
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
  }
  return initializeViewport
}
