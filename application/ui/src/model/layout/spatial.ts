// Where an arrow key goes among terminals laid out in two dimensions, as Grid and Canvas
// show them: to the nearest one on that side, measured on screen.

export type Direction = "up" | "down" | "left" | "right"

export type Rect = {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

type Span = readonly [start: number, end: number]

// Off to the side counts this much more than further ahead, among tiles out of line.
const sideways = 2

const along = (rect: Rect, direction: Direction): Span =>
  direction === "left" || direction === "right"
    ? [rect.left, rect.left + rect.width]
    : [rect.top, rect.top + rect.height]

const across = (rect: Rect, direction: Direction): Span =>
  direction === "left" || direction === "right"
    ? [rect.top, rect.top + rect.height]
    : [rect.left, rect.left + rect.width]

const before = (a: readonly number[], b: readonly number[]): boolean => {
  const index = a.findIndex((value, i) => value !== b[i])
  return index >= 0 && a[index]! < b[index]!
}

const center = ([start, end]: Span): number => (start + end) / 2

// The gap between two spans, or 0 where they overlap.
const gap = (a: Span, b: Span): number => Math.max(0, a[0] - b[1], b[0] - a[1])

// The nearest rect on the `direction` side of `from`, or undefined when none is. A rect
// is on that side when both its edges are past `from`'s, so tiles of different heights
// sharing a row are never above or below one another. Rects in line, overlapping `from`'s
// row or column, come before any out of line, so an arrow keeps to its row or column;
// then nearness is the gap ahead plus the weighted gap to the side, and ties go to the
// closer center.
export const nearestInDirection = <Id>(
  from: Rect,
  candidates: readonly { readonly id: Id; readonly rect: Rect }[],
  direction: Direction,
): Id | undefined => {
  const forward = direction === "right" || direction === "down" ? 1 : -1
  const start = along(from, direction)
  const side = across(from, direction)
  let best: { id: Id; rank: readonly number[] } | undefined
  for (const { id, rect } of candidates) {
    const span = along(rect, direction)
    if ((span[0] - start[0]) * forward <= 0 || (span[1] - start[1]) * forward <= 0) continue
    const ahead = (center(span) - center(start)) * forward
    const offside = gap(across(rect, direction), side)
    const rank = [
      offside > 0 ? 1 : 0,
      gap(span, start) + sideways * offside,
      Math.hypot(ahead, center(across(rect, direction)) - center(side)),
    ]
    if (!best || before(rank, best.rank)) best = { id, rank }
  }
  return best?.id
}
