import type { CanvasLayout } from "../types"

// A point on the canvas, settled onto its 24 px grid.
const step = 24
export const canvasPointPosition = (point: {
  readonly x: number
  readonly y: number
}): { x: number; y: number } => ({
  x: Math.round(point.x / step) * step,
  y: Math.round(point.y / step) * step,
})

// Where a window goes when it's dropped into a view. On the canvas, its top left in canvas
// units. In the grid, which lays itself out from the sidebar's order, the tile it goes before
// in that order, or none to go last.
export type WindowPlace =
  | { readonly canvas: { readonly x: number; readonly y: number } }
  | { readonly grid: { readonly before: string | null } }

// A new window dropped on the canvas: there, settled onto the canvas's grid.
export const droppedCanvasGeometry = (point: {
  readonly x: number
  readonly y: number
}): CanvasLayout["geometry"][string] => ({ position: canvasPointPosition(point) })

// A window already open, dropped on the canvas: it moves there.
export const moveOnCanvas = (
  canvas: CanvasLayout,
  id: string,
  point: { readonly x: number; readonly y: number },
): CanvasLayout => ({
  ...canvas,
  geometry: { ...canvas.geometry, [id]: droppedCanvasGeometry(point) },
})
