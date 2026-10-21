import type { SizePreset } from "../types"

export type WindowSize = { readonly width: number; readonly height: number }

// The size a window opens at on Canvas until the person resizes one: from then on, new
// windows open at the size they last gave a window. 3:2, on Canvas's 24 px grid.
export const defaultCanvasWindowSize: WindowSize = { width: 864, height: 576 }

// A new Grid tile's height in pixels, before it rounds up to whole rows.
export const gridTileHeight = 400

// The smallest window Canvas's resize corner leaves.
export const canvasWindowMinimum: WindowSize = { width: 320, height: 200 }

export const gridPresetWidth = (columns: number, preset: SizePreset): number =>
  preset === "large" ? columns : Math.max(4, Math.floor(columns / 2))
