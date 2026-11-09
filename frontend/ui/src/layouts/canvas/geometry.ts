import { canvasWindowSize } from "@novadeck/core/layout/terminal-size"
import type { XYPosition } from "@xyflow/react"

import type { CanvasViewport, TerminalNode } from "./types"

type Size = { readonly width: number; readonly height: number }

export const canvasStep = 24
export const terminalHeaderHeight = 52
// Apply half the canvas zoom strength to node headers.
export const chromeScaleAt = (zoom: number): number => 1 / Math.sqrt(zoom)
// Agent avatars (experimental): below this zoom a window's title is too small to read, and
// its header's critter grows to stand for the window instead.
export const avatarGrowZoom = 0.45
// How big the critter grows on screen at most, in CSS pixels, over how much more zoom-out,
// and the share of its window's width on screen it never passes, so that far out it
// shrinks with its window again.
const avatarGrownSize = 28
const avatarGrowSpan = 0.2
const avatarWindowShare = 1 / 8
// How many times its header's size the critter is drawn at a zoom: 1 down to
// `avatarGrowZoom`, then growing along one smooth curve from the header critter's size on
// screen (16px by the chrome scale by the zoom, so 16 × √zoom) toward `avatarGrownSize`,
// but never past an eighth of its window's width on screen, nor below the header's size.
export const avatarGrowAt = (zoom: number): number => {
  if (zoom >= avatarGrowZoom) return 1
  const header = 16 * Math.sqrt(zoom)
  const from = 16 * Math.sqrt(avatarGrowZoom)
  const t = Math.min(1, (avatarGrowZoom - zoom) / avatarGrowSpan)
  const eased = t * t * (3 - 2 * t)
  const grown = from + (avatarGrownSize - from) * eased
  const most = windowSize.width * zoom * avatarWindowShare
  return Math.max(1, Math.min(grown, most) / header)
}
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
