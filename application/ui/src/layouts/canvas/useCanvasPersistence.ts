import { useReactFlow } from "@xyflow/react"
import { useCallback, useEffect, useRef, type RefObject } from "react"

import type { CanvasLayout } from "../../model/types"
import { snap } from "./geometry"
import type { CanvasProps, CanvasViewport, TerminalNode } from "./types"

export type CanvasPersistence = {
  readonly geometryRef: RefObject<CanvasLayout["geometry"]>
  readonly dirtyGeometry: RefObject<Set<string>>
  readonly resizing: RefObject<Set<string>>
  readonly viewportRef: RefObject<CanvasViewport>
  readonly mounted: RefObject<boolean>
  readonly commitGeometry: (ids: Iterable<string>) => void
  readonly trackViewport: (viewport: CanvasViewport) => void
  readonly commitViewport: () => void
}

// XYFlow owns live gestures. Persist only completed gestures and the final unmount snapshot.
export const useCanvasPersistence = ({
  layout,
  terminals,
  onLayoutChange,
}: Pick<CanvasProps, "layout" | "terminals" | "onLayoutChange">): CanvasPersistence => {
  const { getNode, getViewport } = useReactFlow<TerminalNode>()
  const geometryRef = useRef<CanvasLayout["geometry"]>({ ...layout.geometry })
  const dirtyGeometry = useRef(new Set<string>())
  const resizing = useRef(new Set<string>())
  const viewportRef = useRef<CanvasViewport>(layout.viewport ?? { x: 0, y: 0, zoom: 1 })
  const dirtyViewport = useRef(false)
  const mounted = useRef(false)
  const latest = useRef({ terminals, onLayoutChange })
  useEffect(() => {
    latest.current = { terminals, onLayoutChange }
  }, [onLayoutChange, terminals])

  const commitGeometry = useCallback((ids: Iterable<string>) => {
    const { onLayoutChange: commitLayout, terminals: liveTerminals } = latest.current
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
    const liveIds = new Set(liveTerminals.map((terminal) => terminal.id))
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

  return {
    geometryRef,
    dirtyGeometry,
    resizing,
    viewportRef,
    mounted,
    commitGeometry,
    trackViewport,
    commitViewport,
  }
}
