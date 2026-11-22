// Where the tour's caption box stands: beside what it names, in space no window takes.

// A rect as the page shows it, by value.
export type Box = {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export type Size = { readonly width: number; readonly height: number }

// How far the box stands from its subject, from the area's edges, and how finely the area is
// searched for free space.
const gap = 18
const margin = 16
const stride = 24

export const sameBox = (a: Box | null, b: Box | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height)

const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height

// Keeps a value within a range, the range's start where it's too small to hold it.
const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(value, high))

/**
 * Where the caption box goes, by its own size, in the page's coordinates, always inside `area`
 * (the workspace) and never over a window (`windows`) where any free space fits it:
 * - beside its subject, below it first, then to its right, above, and to its left;
 * - else the free spot of the area nearest it (with no subject, the lowest), as a Grid's empty
 *   cell, or beside the sidebar where it points into it;
 * - else docked at the foot of the area, in its middle, as in a Grid with no cell free.
 * A modal dialog (`dialogs`) is an obstacle that holds for every step, even one whose box may lie
 * over windows: the box keeps clear of it wherever any free space fits, and otherwise goes to the
 * area's bottom centre rather than over it.
 */
export const placeBox = (
  subject: Box | null,
  card: Size,
  area: Box,
  windows: readonly Box[],
  dialogs: readonly Box[] = [],
): { readonly left: number; readonly top: number } => {
  const fit = (left: number, top: number) => ({
    left: clamp(left, area.left + margin, area.left + area.width - card.width - margin),
    top: clamp(top, area.top + margin, area.top + area.height - card.height - margin),
  })
  const free = (place: { left: number; top: number }): boolean =>
    !windows.some((window) => overlaps({ ...place, ...card }, window)) &&
    !dialogs.some((dialog) => overlaps({ ...place, ...card }, dialog)) &&
    !(subject && overlaps({ ...place, ...card }, subject))
  if (subject) {
    const right = subject.left + subject.width
    const bottom = subject.top + subject.height
    const beside = [
      fit(subject.left, bottom + gap),
      fit(right + gap, subject.top),
      fit(subject.left, subject.top - card.height - gap),
      fit(subject.left - card.width - gap, subject.top),
      fit(right - card.width, bottom + gap),
      fit(right + gap, bottom - card.height),
    ]
    const found = beside.find(free)
    if (found) return found
  }
  // How far a spot is from what it names: its centre from the subject's, or from the area's
  // foot where there is none.
  const centre = subject
    ? { x: subject.left + subject.width / 2, y: subject.top + subject.height / 2 }
    : { x: area.left, y: area.top + area.height }
  const distance = (place: { left: number; top: number }): number =>
    Math.hypot(place.left + card.width / 2 - centre.x, place.top + card.height / 2 - centre.y)
  let best: { left: number; top: number } | null = null
  for (let top = area.top + area.height - card.height - margin; top >= area.top; top -= stride)
    for (
      let left = area.left + margin;
      left + card.width <= area.left + area.width;
      left += stride
    ) {
      const place = fit(left, top)
      if (free(place) && (!best || distance(place) < distance(best))) best = place
    }
  return best ?? fit(area.left + (area.width - card.width) / 2, area.top + area.height)
}
