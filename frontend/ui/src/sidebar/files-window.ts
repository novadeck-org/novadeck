// The part of the Files tree in view. Every line is one fixed height, so which lines show is
// arithmetic on the tree's scroll position and height; nothing is measured per row.

// A tree row's height in px (`.files-row` and `.files-note-row` in files.css).
export const rowHeight = 26

// How many rows are drawn past each edge of the view, so a scroll shows rows already there.
export const overscanRows = 10

export type Window = {
  // The first line drawn, and one past the last: `lines.slice(start, end)`.
  readonly start: number
  readonly end: number
}

// The lines to draw for a tree of `count` lines scrolled to `scrollTop` in a view `viewport`
// tall. A view with no height (not measured yet, or the sidebar is collapsed) draws nothing.
export const windowOf = (
  count: number,
  scrollTop: number,
  viewport: number | undefined,
  overscan: number = overscanRows,
): Window => {
  if (viewport === undefined || viewport <= 0 || count <= 0) return { start: 0, end: 0 }
  // A tree that shrank under a scroll position past its end shows its last screenful, as the
  // browser will once it clamps the scroll.
  const screenful = Math.ceil(viewport / rowHeight)
  const first = Math.min(
    Math.floor(Math.max(0, scrollTop) / rowHeight),
    Math.max(0, count - screenful),
  )
  const last = first + screenful + Math.ceil((Math.max(0, scrollTop) % rowHeight) / rowHeight)
  const start = Math.min(count, Math.max(0, first - overscan))
  return { start, end: Math.min(count, Math.max(start, last + overscan)) }
}

// Where to scroll so line `index` is fully in view, moving as little as it takes; the scroll
// position as it is when the line already is.
export const scrollToLine = (index: number, scrollTop: number, viewport: number): number => {
  const top = index * rowHeight
  if (top < scrollTop) return top
  if (top + rowHeight > scrollTop + viewport) return Math.max(0, top + rowHeight - viewport)
  return scrollTop
}

// A line's place among its siblings, which a screen reader announces for a tree it can't see
// whole: a line's siblings are the lines at its depth under the same parent.
export type Place = { readonly size: number; readonly position: number }

export const placesOf = (depths: readonly number[]): readonly Place[] => {
  const groups: number[][] = []
  const member: { group: number[]; position: number }[] = []
  let previous = -1
  for (const depth of depths) {
    if (depth > previous || groups[depth] === undefined) groups[depth] = []
    const group = groups[depth]!
    group.push(0)
    member.push({ group, position: group.length })
    previous = depth
  }
  return member.map(({ group, position }) => ({ size: group.length, position }))
}
