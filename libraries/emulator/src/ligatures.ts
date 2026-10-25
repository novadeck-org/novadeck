import { ligatureWords } from "./ligature-table.js"

// Which runs of a line the font draws as ligatures, for xterm's character joiner. JetBrains
// Mono makes ligatures by contextual substitution: each glyph of `=>` or `<!--` is swapped for
// a piece that joins its neighbours. The table lists the sequences that trigger it, found in
// the bundled font's own rules (`ligature-table.ts`); a run is every table sequence found in
// the line, overlapping or touching ones merged. The run is then drawn as one string, so the
// font itself shapes it: a run that takes in a glyph the font leaves plain (`=>=` joins only
// `>=`) draws it plain all the same, and a run is shaped the same alone as in its line
// (`ligature-font.test.ts` checks both against the font).

const buckets = new Map<string, string[]>()
for (const word of ligatureWords) {
  const first = word[0] ?? ""
  buckets.set(first, [...(buckets.get(first) ?? []), word])
}
const trigger = new RegExp(`[${[...buckets.keys()].map((c) => `\\${c}`).join("")}]`)

/** The widest run drawn as one glyph, in cells; `runLimit` narrows it for a larger cell. */
export const maxRunCells = 32

/**
 * How many cells a run may take where a cell is `devicePixels` wide. WebGL's glyph atlas keeps
 * a glyph wider than 512 device pixels on one overflow page that evicts nothing, and clips one
 * past the 2048 px texture, so a run stays well inside 480 whatever the pixel ratio.
 */
export const runLimit = (devicePixels: number): number =>
  Math.max(4, Math.min(maxRunCells, Math.floor(480 / Math.max(1, devicePixels))))

/** Whether the table is the family's: JetBrains Mono's, when it is the first the CSS names. */
export const hasTable = (fontFamily: string): boolean =>
  /^\s*["']?jetbrains mono\b/i.test(fontFamily)

// Whether a cut before `at` falls inside four or more of the same glyph, where the font draws
// the same piece either side of the cut (a repeated `=` or `-`, a progress bar's body).
const insideRepeat = (text: string, at: number): boolean =>
  at >= 2 &&
  at + 1 < text.length &&
  text[at - 2] === text[at - 1] &&
  text[at - 1] === text[at] &&
  text[at] === text[at + 1]

// A run cut into parts of at most `limit` cells, none of one cell (which joins nothing): equal
// parts, each cut moved up to an eighth of the limit to the nearest place inside a repeat. A cut
// that finds none stays where it fell, and the font may draw a seam there, as it would not in one run.
const cut = (text: string, from: number, to: number, limit: number): [number, number][] => {
  const parts = Math.ceil((to - from) / (limit * 0.75))
  const slack = Math.floor(limit / 8)
  const points = [from]
  for (let i = 1; i < parts; i++) {
    const ideal = from + Math.round(((to - from) * i) / parts)
    let best = ideal
    search: for (let d = 0; d <= slack; d++)
      for (const at of [ideal - d, ideal + d])
        if (insideRepeat(text, at)) {
          best = at
          break search
        }
    points.push(best)
  }
  points.push(to)
  return points.slice(1).map((end, i) => [points[i] ?? from, end])
}

/**
 * The `[from, to)` index ranges of `text` to draw as one run each, in order, each at most
 * `limit` cells (a longer one is cut into parts).
 */
export const ligatureRuns = (text: string, limit = maxRunCells): [number, number][] => {
  if (!trigger.test(text)) return []
  const runs: [number, number][] = []
  for (let at = 0; at < text.length; at++) {
    for (const word of buckets.get(text[at] ?? "") ?? []) {
      if (!text.startsWith(word, at)) continue
      const end = at + word.length
      const last = runs[runs.length - 1]
      if (last && at <= last[1]) last[1] = Math.max(last[1], end)
      else runs.push([at, end])
    }
  }
  return runs.flatMap(([from, to]) =>
    to - from > limit ? cut(text, from, to, limit) : [[from, to]],
  )
}
