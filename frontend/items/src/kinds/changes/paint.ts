import type { HighlightedLine } from "@novadeck/viewers/code"
import type { Marks } from "@novadeck/viewers/facts"

// A line's text as the pieces it is drawn in: a piece for each stretch of one kind of token and
// one marking, the classes of the syntax highlight on it and whether the stretch is a changed
// token.

export type Segment = {
  readonly text: string
  readonly classes: string
  readonly marked: boolean
}

export const segmentsOf = (
  text: string,
  runs: HighlightedLine | undefined,
  marks: Marks,
): Segment[] => {
  if (text === "") return []
  const cuts = new Set([0, text.length])
  for (const run of runs ?? []) {
    cuts.add(Math.min(run.from, text.length))
    cuts.add(Math.min(run.from + run.text.length, text.length))
  }
  for (const [from, to] of marks) {
    cuts.add(Math.min(from, text.length))
    cuts.add(Math.min(to, text.length))
  }
  const points = [...cuts].toSorted((a, b) => a - b)
  const out: Segment[] = []
  for (const [at, from] of points.entries()) {
    const to = points[at + 1]
    if (to === undefined) break
    const run = runs?.find((each) => each.from <= from && from < each.from + each.text.length)
    const marked = marks.some(([start, end]) => start <= from && from < end)
    const classes = run?.classes ?? ""
    const last = out.at(-1)
    // Neighbours of one kind are one piece.
    if (last && last.classes === classes && last.marked === marked)
      out[out.length - 1] = { ...last, text: last.text + text.slice(from, to) }
    else out.push({ text: text.slice(from, to), classes, marked })
  }
  return out
}
