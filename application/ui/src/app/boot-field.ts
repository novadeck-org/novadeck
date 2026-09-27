// The boot splash's decorative field: empty terminal slots around the lockup, each
// jacking in (filling with a terminal) in turn, clockwise from the top. Positions are
// percentages of the window; widths are percentages of the tile.
export type FieldSlot = {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  // When the slot jacks in, in order around the lockup.
  readonly order: number
  readonly title: number
  readonly lines: readonly number[]
  readonly cursor: boolean
}

// Deterministic randomness, so the field looks the same on every launch.
const random = (seed: number): (() => number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A 6 × 4 grid with the middle four by two left clear for the lockup: 16 slots.
export const fieldSlots = (): readonly FieldSlot[] => {
  const cols = 6
  const rows = 4
  const x0 = 3
  const y0 = 4
  const cw = 94 / cols
  const ch = 92 / rows
  const cells: { c: number; r: number; angle: number }[] = []
  for (let r = 0; r < rows; r += 1)
    for (let c = 0; c < cols; c += 1) {
      if (c >= 1 && c <= 4 && r >= 1 && r <= 2) continue
      const dx = x0 + (c + 0.5) * cw - 50
      const dy = y0 + (r + 0.5) * ch - 50
      cells.push({ c, r, angle: (Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI) })
    }
  const clockwise = cells.toSorted((a, b) => a.angle - b.angle)
  return cells.map((cell, index) => {
    const next = random(index * 97 + 13)
    const title = 22 + next() * 30
    const lines = [30 + next() * 30]
    const count = 2 + Math.floor(next() * 3)
    for (let line = 0; line < count; line += 1) lines.push(35 + next() * 55)
    return {
      left: x0 + cell.c * cw,
      top: y0 + cell.r * ch,
      width: cw,
      height: ch,
      order: clockwise.indexOf(cell),
      title,
      lines,
      cursor: index % 3 === 0,
    }
  })
}
