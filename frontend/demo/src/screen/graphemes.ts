// What a text's characters are as a person sees them: a letter with its marks, an emoji with
// its modifiers, a family joined into one. `Intl.Segmenter` finds them where the browser has
// it, made the first time it's needed, so a page in a browser without it (Firefox before 125)
// still loads. There, each code point stands alone: a joined emoji or an accent may part from
// what it joins, but no surrogate pair is ever split and nothing is lost.

export type Grapheme = { readonly segment: string; readonly index: number }

let segmenter: Intl.Segmenter | undefined

const segmenterOf = (): Intl.Segmenter | undefined => {
  if (!segmenter && typeof Intl !== "undefined" && typeof Intl.Segmenter === "function")
    segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  return segmenter
}

// The text's characters, each with where it starts.
export const graphemesOf = (text: string): Grapheme[] => {
  const found = segmenterOf()
  if (found) return Array.from(found.segment(text), ({ segment, index }) => ({ segment, index }))
  const points: Grapheme[] = []
  let index = 0
  for (const segment of text) {
    points.push({ segment, index })
    index += segment.length
  }
  return points
}
