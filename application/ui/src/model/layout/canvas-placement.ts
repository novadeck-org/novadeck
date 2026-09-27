import type { CanvasLayout, TerminalMetadata } from "../types"

const gap = 60
const defaultWidth = 550
const newWidth = 600
const snap = (value: number): number => Math.round(value / 24) * 24

type CanvasBox = { position: { x: number; y: number }; width: number; height: number }
type Viewport = { x: number; y: number; zoom: number }

export const canvasPointPosition = (point: { x: number; y: number }): { x: number; y: number } => ({
  x: snap(point.x),
  y: snap(point.y),
})

export const viewportCanvasPosition = (
  occupied: CanvasBox[],
  viewport: Viewport,
  viewportSize: { width: number; height: number },
  size: { width: number; height: number },
): { x: number; y: number } => {
  const left = -viewport.x / viewport.zoom
  const top = -viewport.y / viewport.zoom
  const right = (viewportSize.width - viewport.x) / viewport.zoom
  const bottom = (viewportSize.height - viewport.y) / viewport.zoom
  const center = { x: (left + right) / 2, y: (top + bottom) / 2 }
  const nearby = occupied.filter(
    ({ position, width, height }) =>
      position.x < right + size.width + gap &&
      position.x + width > left - size.width - gap &&
      position.y < bottom + size.height + gap &&
      position.y + height > top - size.height - gap,
  )
  const xs = [center.x - size.width / 2, left + gap, right - size.width - gap]
  const ys = [center.y - size.height / 2, top + gap, bottom - size.height - gap]
  for (const box of nearby) {
    xs.push(
      Math.ceil((box.position.x + box.width + gap) / 24) * 24,
      Math.floor((box.position.x - size.width - gap) / 24) * 24,
    )
    ys.push(
      Math.ceil((box.position.y + box.height + gap) / 24) * 24,
      Math.floor((box.position.y - size.height - gap) / 24) * 24,
    )
  }
  let best: { x: number; y: number; visible: number; distance: number } | undefined
  for (const rawX of xs) {
    for (const rawY of ys) {
      const x = snap(rawX)
      const y = snap(rawY)
      const free = occupied.every(
        ({ position, width, height }) =>
          x + size.width + gap <= position.x ||
          position.x + width + gap <= x ||
          y + size.height + gap <= position.y ||
          position.y + height + gap <= y,
      )
      if (!free) continue
      const visible =
        Math.max(0, Math.min(x + size.width, right) - Math.max(x, left)) *
        Math.max(0, Math.min(y + size.height, bottom) - Math.max(y, top))
      const distance = Math.hypot(x + size.width / 2 - center.x, y + size.height / 2 - center.y)
      if (!best || visible > best.visible || (visible === best.visible && distance < best.distance))
        best = { x, y, visible, distance }
    }
  }
  return best
    ? { x: best.x, y: best.y }
    : {
        x: snap(
          Math.max(right, ...occupied.map(({ position, width }) => position.x + width)) + gap,
        ),
        y: snap(center.y - size.height / 2),
      }
}

const bounds = (terminal: TerminalMetadata, layout: CanvasLayout) => ({
  position: layout.geometry[terminal.id]?.position ?? { x: 80, y: 80 },
  width: layout.geometry[terminal.id]?.width ?? defaultWidth,
  height: layout.geometry[terminal.id]?.height ?? 400,
})

export const adjacentCanvasPosition = (
  active: TerminalMetadata,
  terminals: TerminalMetadata[],
  layout: CanvasLayout,
  height: number,
): { x: number; y: number } => {
  const anchor = bounds(active, layout)
  const occupied = terminals.map((terminal) => bounds(terminal, layout))
  const isFree = (x: number, y: number): boolean =>
    occupied.every(
      ({ position, width, height: occupiedHeight }) =>
        x + newWidth + gap <= position.x ||
        position.x + width + gap <= x ||
        y + height + gap <= position.y ||
        position.y + occupiedHeight + gap <= y,
    )
  for (let step = 0; step <= terminals.length; step++) {
    const offset = step * (height + gap)
    const candidates = [
      { x: anchor.position.x + anchor.width + gap, y: anchor.position.y + offset },
      { x: anchor.position.x, y: anchor.position.y + anchor.height + gap + offset },
    ]
    const free = candidates.find(({ x, y }) => isFree(x, y))
    if (free) return free
  }
  return {
    x: anchor.position.x,
    y:
      Math.max(
        ...occupied.map(({ position, height: occupiedHeight }) => position.y + occupiedHeight),
      ) + gap,
  }
}
