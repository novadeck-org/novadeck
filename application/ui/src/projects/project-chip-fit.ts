// How many of the chips, from the first, fit in `available` pixels, each at its natural
// width with `gap` between them. A chip that doesn't fit leaves out those after it too,
// so the person's order is never skipped over.
export const chipsThatFit = (available: number, widths: readonly number[], gap: number): number => {
  let used = 0
  for (const [index, width] of widths.entries()) {
    used += width + (index > 0 ? gap : 0)
    if (used > available) return index
  }
  return widths.length
}
