import { canvasWindowMinimum } from "@novadeck/core/layout/terminal-size"
import type { XYPosition } from "@xyflow/react"

import type { CanvasViewport, TerminalNode } from "./types"

type Size = { readonly width: number; readonly height: number }

export const canvasStep = 24
export const snap = (value: number): number => Math.round(value / canvasStep) * canvasStep
export const terminalHeaderHeight = 52
// Apply half the canvas zoom strength to node headers and resize grips.
export const chromeScaleAt = (zoom: number): number => 1 / Math.sqrt(zoom)
// Where and how large a window is taken to be until the canvas knows its own.
export const fallbackPosition: Readonly<XYPosition> = { x: 80, y: 80 }
export const fallbackSize: Size = { width: 550, height: 400 }
// The least a resized window snaps to: Canvas's minimum, rounded up to its grid.
const snapUp = (value: number): number => Math.ceil(value / canvasStep) * canvasStep
export const minimumSize: Size = {
  width: snapUp(canvasWindowMinimum.width),
  height: snapUp(canvasWindowMinimum.height),
}
// A window's size where it is known, the fallback's where it isn't yet.
export const sizeOr = (width: number | undefined, height: number | undefined): Size => ({
  width: width ?? fallbackSize.width,
  height: height ?? fallbackSize.height,
})
export const centerOf = (node: TerminalNode): XYPosition => {
  const size = sizeOr(node.width, node.height)
  return { x: node.position.x + size.width / 2, y: node.position.y + size.height / 2 }
}

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
