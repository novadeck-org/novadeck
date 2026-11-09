import { canvasWindowSize } from "@novadeck/core/layout/terminal-size"
import type { XYPosition } from "@xyflow/react"

import type { CanvasViewport, TerminalNode } from "./types"

type Size = { readonly width: number; readonly height: number }

export const canvasStep = 24
export const terminalHeaderHeight = 52
// Apply half the canvas zoom strength to node headers.
export const chromeScaleAt = (zoom: number): number => 1 / Math.sqrt(zoom)
// Every window on Canvas is one size.
export const windowSize: Size = canvasWindowSize
export const centerOf = (node: TerminalNode): XYPosition => ({
  x: node.position.x + windowSize.width / 2,
  y: node.position.y + windowSize.height / 2,
})

export const fitOptions = { padding: 0.08, maxZoom: 1 }

// Whether a window at `position` lies wholly on screen, `margin` screen pixels clear of each
// edge.
export const onScreen = (
  position: XYPosition,
  { width, height }: Size,
  viewport: CanvasViewport,
  screen: Size,
  margin = 24,
): boolean => {
  const inset = margin / viewport.zoom
  const left = -viewport.x / viewport.zoom
  const top = -viewport.y / viewport.zoom
  const right = (screen.width - viewport.x) / viewport.zoom
  const bottom = (screen.height - viewport.y) / viewport.zoom
  return (
    position.x >= left + inset &&
    position.y >= top + inset &&
    position.x + width <= right - inset &&
    position.y + height <= bottom - inset
  )
}

// Whether any of a window at `position` shows on screen.
export const inSight = (position: XYPosition, viewport: CanvasViewport, screen: Size): boolean =>
  (position.x + windowSize.width) * viewport.zoom + viewport.x > 0 &&
  position.x * viewport.zoom + viewport.x < screen.width &&
  (position.y + windowSize.height) * viewport.zoom + viewport.y > 0 &&
  position.y * viewport.zoom + viewport.y < screen.height
