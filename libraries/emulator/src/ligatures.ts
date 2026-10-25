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

/** The `[from, to)` index ranges of `text` to draw as one run each, in order, none touching. */
export const ligatureRuns = (text: string): [number, number][] => {
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
  return runs
}
