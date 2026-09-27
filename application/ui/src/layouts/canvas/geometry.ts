import type { XYPosition } from "@xyflow/react"

import type { TerminalNode } from "./types"

export const canvasStep = 24
export const snap = (value: number): number => Math.round(value / canvasStep) * canvasStep
export const terminalHeaderHeight = 52
// Apply half the canvas zoom strength to node headers and resize grips.
export const chromeScaleAt = (zoom: number): number => 1 / Math.sqrt(zoom)
export const centerOf = (node: TerminalNode, zoom: number): XYPosition => ({
  x: node.position.x + (node.width ?? 550) / 2,
  y:
    node.position.y +
    (node.data.minimized ? terminalHeaderHeight * chromeScaleAt(zoom) + 2 : (node.height ?? 400)) /
      2,
})

export const fitOptions = { padding: 0.08, maxZoom: 1 }
