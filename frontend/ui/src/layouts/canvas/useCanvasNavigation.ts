import {
  getNodesBounds,
  getViewportForBounds,
  useNodesInitialized,
  useReactFlow,
  type ReactFlowInstance,
  type XYPosition,
} from "@xyflow/react"
import { useEffect, useRef, type RefObject } from "react"

import { prefersReducedMotion } from "../../interaction/reduced-motion"
import {
  centerOf,
  chromeScaleAt,
  fitOptions,
  onScreen,
  terminalHeaderHeight,
  windowSize,
} from "./geometry"
import type { CanvasProps, CanvasViewport, TerminalNode } from "./types"
import type { createCanvasVisit } from "./visit"

type NavigationProps = Pick<
  CanvasProps,
  "navigation" | "selected" | "hidden" | "fitOnNavigate" | "flyOnNavigate"
> & {
  // The canvas opens as it was left (Canvas.tsx): it keeps the camera it was left with.
  restored: boolean
  initialViewport: CanvasViewport | undefined
  // Read when needed: it changes every frame while the sidebar slides.
  viewportSize: () => { width: number; height: number }
  container: RefObject<HTMLDivElement | null>
  // Where the canvas put each window that opened since it last revealed one.
  createdPositions: RefObject<Map<string, XYPosition>>
  visit: ReturnType<typeof createCanvasVisit>
  // Hands over the sheets open as Canvas mounts, by terminal, which the first camera also
  // has to fit; after that, a sheet opening frames itself.
  takeEntrySheets: () => Map<string, { right: number; height: number }>
  // Flies the camera in to a terminal, as `flyOnNavigate` asks.
  flyIn: (id: string) => void
}

// Whether a node's Focus button may be on screen under `viewport`. It sits beside Close at
// the header's right end, 0.6 to 1.6 header-heights in from it in either header size; any of
// that span on screen, at the middle of the header's height, counts.
const focusButtonInView = (
  node: TerminalNode,
  viewport: CanvasViewport,
  container: HTMLElement,
): boolean => {
  const right = (node.position.x + windowSize.width) * viewport.zoom + viewport.x
  const top = node.position.y * viewport.zoom + viewport.y
  const header = terminalHeaderHeight * chromeScaleAt(viewport.zoom) * viewport.zoom
  return (
    right - header * 0.6 > 0 &&
    right - header * 1.6 < container.clientWidth &&
    top + header / 2 >= 0 &&
    top + header / 2 <= container.clientHeight
  )
}

// Sidebar navigation and new-terminal revelation preserve zoom unless fitting is requested.
export const useCanvasNavigation = ({
  navigation,
  selected,
  hidden,
  fitOnNavigate,
  flyOnNavigate,
  restored,
  initialViewport,
  viewportSize,
  container,
  createdPositions,
  visit,
  takeEntrySheets,
  flyIn,
}: NavigationProps) => {
  const { fitView, getNode, getViewport, setCenter } = useReactFlow<TerminalNode>()
  const initialized = useNodesInitialized()
  // Canvas sets its camera as it opens (below), and flies from there to a terminal gone to
  // from outside; only new sidebar requests recenter it.
  const lastNavigation = useRef(navigation)
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
      createdPositions.current.delete(selected)
      return flyIn(selected)
    }
    visit.clear()
    const duration = prefersReducedMotion() ? 0 : 180
    const created = createdPositions.current.get(selected)
    if (created) {
      createdPositions.current.delete(selected)
      const viewport = getViewport()
      if (onScreen(created, windowSize, viewport, viewportSize())) return
      void setCenter(created.x + windowSize.width / 2, created.y + windowSize.height / 2, {
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
    createdPositions,
  ])

  // Canvas frames every visible window as it opens, however its camera was left: its
  // windows are arranged afresh, so that camera points at nothing in particular. Come back
  // to from Focus by a window's own button, it is as it was left instead: it keeps that
  // camera, or brings the terminal it comes back on to the middle unless its Focus button is
  // in sight. A terminal gone to from outside the canvas is flown in to from the framing:
  // from here, once that camera is set.
  const initializeViewport = (instance: ReactFlowInstance<TerminalNode>) => {
    // Taken whichever camera this sets, or keeps: from here, a sheet opening frames itself.
    const sheets = takeEntrySheets()
    const framing = !restored || flyOnNavigate
    if (!container.current) return
    const selectedNode = framing ? undefined : instance.getNode(selected)
    const target = selectedNode?.hidden ? undefined : selectedNode
    if (initialViewport && target && !fitOnNavigate) {
      // One whose Focus button is still in sight keeps the camera it was left with, as on
      // coming back from Focus to where it was opened from.
      if (focusButtonInView(target, initialViewport, container.current)) return
      const center = centerOf(target)
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
    // Compute the first camera before a view-transition snapshot, without waiting for paint.
    const framed = instance.setViewport(
      getViewportForBounds(
        bounds,
        container.current.clientWidth,
        container.current.clientHeight,
        0.15,
        target && fitOnNavigate ? 1.5 : fitOptions.maxZoom,
        fitOptions.padding,
      ),
    )
    if (!flyOnNavigate) return
    createdPositions.current.delete(selected)
    void framed.then(() => flyIn(selected))
  }
  return initializeViewport
}
