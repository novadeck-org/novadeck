import {
  getNodesBounds,
  getViewportForBounds,
  useNodesInitialized,
  useReactFlow,
  type ReactFlowInstance,
  type XYPosition,
} from "@xyflow/react"
import { useEffect, useRef, type RefObject } from "react"

import type { CanvasLayout } from "../../model/types"
import { centerOf, fitOptions } from "./geometry"
import type { CanvasProps, CanvasViewport, TerminalNode } from "./types"
import type { createCanvasVisit } from "./visit"

type NavigationProps = Pick<
  CanvasProps,
  "navigation" | "selected" | "hidden" | "fitOnNavigate" | "revealOnMount"
> & {
  initialViewport: CanvasViewport | undefined
  viewportWidth: number
  viewportHeight: number
  container: RefObject<HTMLDivElement | null>
  geometryRef: RefObject<CanvasLayout["geometry"]>
  createdPositions: RefObject<Map<string, XYPosition>>
  pointerCreated: RefObject<Set<string>>
  visit: ReturnType<typeof createCanvasVisit>
}

// Sidebar navigation and new-terminal revelation preserve zoom unless fitting is requested.
export const useCanvasNavigation = ({
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
}: NavigationProps) => {
  const { fitView, getNode, getViewport, setCenter } = useReactFlow<TerminalNode>()
  const initialized = useNodesInitialized()
  // Returning to Canvas restores its camera; only new sidebar requests recenter it.
  const lastNavigation = useRef(initialViewport ? navigation : 0)
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
    geometryRef,
    pointerCreated,
    createdPositions,
  ])

  const initializeViewport = (instance: ReactFlowInstance<TerminalNode>) => {
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
  }
  return initializeViewport
}
