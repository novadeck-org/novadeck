import { useReactFlow } from "@xyflow/react"
import { useCallback, useEffect, useRef, type RefObject } from "react"

import type { CanvasProps, CanvasViewport, TerminalNode } from "./types"

export type CanvasPersistence = {
  readonly viewportRef: RefObject<CanvasViewport>
  readonly mounted: RefObject<boolean>
  readonly trackViewport: (viewport: CanvasViewport) => void
  readonly commitViewport: () => void
}

// Canvas keeps its camera, and nothing of where its windows are: it arranges them itself
// (stay.ts). XYFlow owns live gestures; only a camera move that has ended
// and the final unmount snapshot are saved.
export const useCanvasPersistence = ({
  layout,
  onLayoutChange,
}: Pick<CanvasProps, "layout" | "onLayoutChange">): CanvasPersistence => {
  const { getViewport } = useReactFlow<TerminalNode>()
  const viewportRef = useRef<CanvasViewport>(layout.viewport ?? { x: 0, y: 0, zoom: 1 })
  const dirtyViewport = useRef(false)
  const mounted = useRef(false)
  const latest = useRef(onLayoutChange)
  useEffect(() => {
    latest.current = onLayoutChange
  }, [onLayoutChange])

  const trackViewport = useCallback((viewport: CanvasViewport) => {
    viewportRef.current = { ...viewport }
    dirtyViewport.current = true
  }, [])

  const commitViewport = useCallback(() => {
    if (!dirtyViewport.current) return
    const viewport = { ...viewportRef.current }
    dirtyViewport.current = false
    latest.current((previous) =>
      previous.viewport?.x === viewport.x &&
      previous.viewport.y === viewport.y &&
      previous.viewport.zoom === viewport.zoom
        ? previous
        : { ...previous, viewport },
    )
  }, [])

  useEffect(() => {
    if (!dirtyViewport.current && layout.viewport) viewportRef.current = { ...layout.viewport }
  }, [layout.viewport])

  useEffect(
    () => () => {
      if (!dirtyViewport.current) return
      trackViewport(getViewport())
      commitViewport()
    },
    [commitViewport, getViewport, trackViewport],
  )

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  return { viewportRef, mounted, trackViewport, commitViewport }
}
