import type { SizePreset } from "../types"

export type WindowSize = { readonly width: number; readonly height: number }

// The size of every window on Canvas, where nobody sizes them: 3:2, on Canvas's 24 px grid.
export const canvasWindowSize: WindowSize = { width: 864, height: 576 }

// A new Grid tile's height in pixels, before it rounds up to whole rows.
export const gridTileHeight = 400

export const gridPresetWidth = (columns: number, preset: SizePreset): number =>
  preset === "large" ? columns : Math.max(4, Math.floor(columns / 2))
