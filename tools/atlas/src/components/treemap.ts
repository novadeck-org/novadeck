type Rect<T> = { item: T; x: number; y: number; w: number; h: number }

// Squarified treemap: lays `items` out in the box so each rect's area is its share of the
// total value, keeping rects close to square.
export const squarify = <T>(
  items: { item: T; value: number }[],
  x: number,
  y: number,
  w: number,
  h: number,
): Rect<T>[] => {
  const total = items.reduce((sum, i) => sum + i.value, 0)
  if (total <= 0 || w <= 0 || h <= 0) return []
  const scale = (w * h) / total
  let rest = items
    .filter((i) => i.value > 0)
    .toSorted((a, b) => b.value - a.value)
    .map((i) => ({ item: i.item, area: i.value * scale }))
  const out: Rect<T>[] = []
  let [cx, cy, cw, ch] = [x, y, w, h]
  while (rest.length > 0) {
    const short = Math.min(cw, ch)
    const worst = (areas: number[], sum: number) => {
      const max = Math.max(...areas)
      const min = Math.min(...areas)
      return Math.max((short * short * max) / (sum * sum), (sum * sum) / (short * short * min))
    }
    let count = 1
    let sum = rest[0]!.area
    while (count < rest.length) {
      const next = rest[count]!.area
      const row = rest.slice(0, count).map((r) => r.area)
      if (worst([...row, next], sum + next) > worst(row, sum)) break
      sum += next
      count++
    }
    const thick = sum / short
    let cursor = cw >= ch ? cy : cx
    for (const r of rest.slice(0, count)) {
      const len = r.area / thick
      if (cw >= ch) out.push({ item: r.item, x: cx, y: cursor, w: thick, h: len })
      else out.push({ item: r.item, x: cursor, y: cy, w: len, h: thick })
      cursor += len
    }
    if (cw >= ch) {
      cx += thick
      cw -= thick
    } else {
      cy += thick
      ch -= thick
    }
    rest = rest.slice(count)
  }
  return out
}
