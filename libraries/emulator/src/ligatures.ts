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

const longestWord = ligatureWords.reduce((most, word) => Math.max(most, word.length), 0)

/**
 * How many cells a run may take where a cell is `devicePixels` wide, or 0 where that is fewer
 * than the longest sequence (nothing is joined then). WebGL's glyph atlas keeps a glyph wider
 * than 512 device pixels on one overflow page that evicts nothing, and clips one past the 2048 px
 * texture, so a run stays well inside 480 whatever the pixel ratio.
 */
export const runLimit = (devicePixels: number): number => {
  const cells = Math.min(maxRunCells, Math.floor(480 / Math.max(1, devicePixels)))
  return cells < longestWord ? 0 : cells
}

/** Whether the table is the family's: JetBrains Mono's, when it is the first the CSS names. */
export const hasLigatureTable = (fontFamily: string): boolean =>
  /^\s*["']?jetbrains mono\b/i.test(fontFamily)

// How far into a stretch of one repeated glyph a cut must be, from either end, for the font to
// draw the same glyphs either side of it as in one piece. The font's rules reach four glyphs
// into a stretch from what borders it (measured over every glyph of the table, with up to four
// glyphs of any other kind on each side, `ligature-font.test.ts`); this is twice that. A cut
// anywhere else may change a glyph: `|---|---|` drawn in two parts gets a tee at the cut.
export const cutMargin = 8

// Where a run may be cut: inside a stretch of the same glyph, `cutMargin` cells from both its
// ends, in order.
const safeCuts = (text: string, from: number, to: number): number[] => {
  const cuts: number[] = []
  let start = from
  while (start > 0 && text[start - 1] === text[start]) start--
  while (start < to) {
    let end = start + 1
    while (end < text.length && text[end] === text[start]) end++
    for (let at = Math.max(start + cutMargin, from + 1); at <= end - cutMargin && at < to; at++)
      cuts.push(at)
    start = end
  }
  return cuts
}

// A run in parts of at most `limit` cells, cut only where the font draws the same either side.
// A part between two cuts is at least `cutMargin` cells: the font draws a shorter stretch of
// four glyphs or fewer in forms of its own (`===`), not the ones it draws inside a longer one.
// Where none falls within a part's reach, the cells up to the next cut that does are left
// unjoined (drawn as plain glyphs, as with ligatures off), or to the run's end where there is
// none: a few plain cells beat a glyph the font would not draw there.
const cut = (text: string, from: number, to: number, limit: number): [number, number][] => {
  // No two cuts a part's width apart, so no part.
  if (limit < 2 * cutMargin) return []
  const cuts = safeCuts(text, from, to)
  const parts: [number, number][] = []
  let start = from
  // The first cut past the part's reach; `start` only grows, and so does it.
  let next = 0
  while (to - start > limit) {
    while (next < cuts.length && cuts[next]! <= start + limit) next++
    const within = cuts[next - 1]
    if (within !== undefined && within >= start + cutMargin) {
      parts.push([start, within])
      start = within
      continue
    }
    const beyond = cuts[next]
    if (beyond === undefined) return parts
    start = beyond
  }
  if (to - start >= 2) parts.push([start, to])
  return parts
}

/**
 * The `[from, to)` index ranges of `text` to draw as one run each, in order, each at most
 * `limit` cells (a longer one is cut into parts).
 */
export const ligatureRuns = (text: string, limit = maxRunCells): [number, number][] => {
  if (limit < longestWord || !trigger.test(text)) return []
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
