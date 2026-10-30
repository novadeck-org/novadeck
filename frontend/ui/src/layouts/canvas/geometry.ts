import type { XYPosition } from "@xyflow/react"

import type { TerminalNode } from "./types"

export const canvasStep = 24
export const snap = (value: number): number => Math.round(value / canvasStep) * canvasStep
export const terminalHeaderHeight = 52
// Apply half the canvas zoom strength to node headers and resize grips.
export const chromeScaleAt = (zoom: number): number => 1 / Math.sqrt(zoom)
// Where and how large a window is taken to be until the canvas knows its own.
export const fallbackPosition: XYPosition = { x: 80, y: 80 }
export const fallbackSize = { width: 550, height: 400 }
// The least a resized window snaps to: Canvas's minimum, rounded up to its grid.
export const minimumSize = { width: 336, height: 216 }
export const centerOf = (node: TerminalNode): XYPosition => ({
  x: node.position.x + (node.width ?? fallbackSize.width) / 2,
  y: node.position.y + (node.height ?? fallbackSize.height) / 2,
})

export const fitOptions = { padding: 0.08, maxZoom: 1 }
