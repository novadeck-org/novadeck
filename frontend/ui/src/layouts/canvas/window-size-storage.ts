import {
  canvasWindowMinimum,
  defaultCanvasWindowSize,
  type WindowSize,
} from "@novadeck/core/layout/terminal-size"

// The size the person last gave a window on Canvas, which new windows open at.
export const canvasWindowSizeStorageKey = "novadeck.canvas-window-size"

const dimension = (value: unknown, minimum: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : undefined

export const readCanvasWindowSize = (): WindowSize => {
  try {
    const stored = JSON.parse(localStorage.getItem(canvasWindowSizeStorageKey) ?? "null") as {
      width?: unknown
      height?: unknown
    } | null
    const width = dimension(stored?.width, canvasWindowMinimum.width)
    const height = dimension(stored?.height, canvasWindowMinimum.height)
    return width && height ? { width, height } : defaultCanvasWindowSize
  } catch {
    return defaultCanvasWindowSize
  }
}

export const writeCanvasWindowSize = (size: WindowSize): void => {
  try {
    localStorage.setItem(canvasWindowSizeStorageKey, JSON.stringify(size))
  } catch {
    /* The size holds for this session when storage is unavailable. */
  }
}
