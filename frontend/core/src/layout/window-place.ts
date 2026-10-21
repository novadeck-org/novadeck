import type { CanvasLayout, GridBreakpoint, GridItem, GridLayouts } from "../types"
import { canvasPointPosition } from "./canvas-placement"
import type { WindowSize } from "./terminal-size"

export type GridCell = {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

// Where a window goes when it's dropped into a view. On the canvas, its top left in canvas
// units. On the grid, its cell at the width the grid had then, and that width's saved
// layout with room made for it.
export type WindowPlace =
  | { readonly canvas: { readonly x: number; readonly y: number } }
  | {
      readonly grid: {
        readonly breakpoint: GridBreakpoint
        readonly layout: readonly GridItem[]
        readonly cell: GridCell
      }
    }

// A new window dropped on the canvas: there, at a new window's size, settled onto the
// canvas's grid.
export const droppedCanvasGeometry = (
  point: { readonly x: number; readonly y: number },
  size: WindowSize,
): CanvasLayout["geometry"][string] => ({
  position: canvasPointPosition(point),
  width: size.width,
  height: size.height,
})

// A window already open, dropped on the canvas: it moves there and keeps its size, or
// takes a new window's if Canvas never placed it.
export const moveOnCanvas = (
  canvas: CanvasLayout,
  id: string,
  point: { readonly x: number; readonly y: number },
  size: WindowSize,
): CanvasLayout => ({
  ...canvas,
  geometry: {
    ...canvas.geometry,
    [id]: {
      ...droppedCanvasGeometry(point, size),
      ...canvas.geometry[id],
      position: canvasPointPosition(point),
    },
  },
})

// The grid's layouts with window `id` in its dropped cell, and nowhere else at that width.
export const dropOnGrid = (
  layouts: GridLayouts,
  id: string,
  { breakpoint, layout, cell }: Extract<WindowPlace, { grid: unknown }>["grid"],
): GridLayouts => ({
  ...layouts,
  [breakpoint]: [...layout.filter((item) => item.i !== id), { i: id, ...cell, minW: 4, minH: 10 }],
})
