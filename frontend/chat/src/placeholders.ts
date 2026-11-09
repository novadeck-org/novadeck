import type { Attachment } from "./attachments"

// Where an image stands in the words of a draft: its placeholder, `[Image #k]`, typed in at
// the place, as Claude Code writes one. The draft holds the placeholders and the attachments
// hold the images, joined by the number `k` (`Attachment.n`): a placeholder with no image is
// just text, and an image whose placeholder was deleted is let go.

export const markOf = (n: number): string => `[Image #${n}]`

type Mark = { readonly n: number; readonly start: number; readonly end: number }

// The placeholders in the text, in order.
const marksIn = (text: string): Mark[] =>
  [...text.matchAll(/\[Image #(\d+)\]/g)].map((match) => ({
    n: Number(match[1]),
    start: match.index,
    end: match.index + match[0].length,
  }))

// The placeholder of each image that holds one, by the image's number: the first of a number
// is the image's, a repeat is text.
const placed = (text: string, images: readonly Attachment[]): Map<number, Mark> => {
  const own = new Set(images.map(({ n }) => n))
  const found = new Map<number, Mark>()
  for (const mark of marksIn(text))
    if (own.has(mark.n) && !found.has(mark.n)) found.set(mark.n, mark)
  return found
}

// The number of the next image: one past the highest the draft or its images use, and 1 where
// it holds none.
export const nextMark = (text: string, images: readonly Attachment[]): number =>
  1 + Math.max(0, ...marksIn(text).map(({ n }) => n), ...images.map(({ n }) => n))

// The draft with `marks` typed in over the selection `start`..`end`, a space between them and
// the words around where the words would run together, and one after, for the person to go on
// typing; and where the caret goes, after them.
export const insertMarks = (
  draft: string,
  start: number,
  end: number,
  marks: readonly number[],
): { readonly text: string; readonly caret: number } => {
  const from = Math.min(Math.max(0, Math.min(start, end)), draft.length)
  const to = Math.min(Math.max(from, Math.max(start, end)), draft.length)
  const before = draft.slice(0, from)
  const after = draft.slice(to)
  const lead = before !== "" && !/\s$/.test(before) ? " " : ""
  const trail = /^\s/.test(after) ? "" : " "
  const inserted = `${lead}${marks.map(markOf).join(" ")}`
  return {
    text: `${before}${inserted}${trail}${after}`,
    caret: before.length + inserted.length + (trail === "" ? 0 : trail.length),
  }
}

// The draft without the placeholder of image `n`, and one of the spaces that held it apart
// from its words, so no double space is left behind.
export const withoutMark = (draft: string, n: number): string => {
  const mark = marksIn(draft).find((each) => each.n === n)
  if (!mark) return draft
  const before = draft.slice(0, mark.start)
  const after = draft.slice(mark.end)
  if (/\s$/.test(before) && /^\s/.test(after)) return `${before}${after.slice(1)}`
  if (before === "" && after.startsWith(" ")) return after.slice(1)
  return `${before}${after}`
}

// The images the draft still holds a placeholder for, and those it doesn't, which are let go.
export const heldImages = (
  draft: string,
  images: readonly Attachment[],
): { readonly kept: readonly Attachment[]; readonly gone: readonly Attachment[] } => {
  const found = placed(draft, images)
  return {
    kept: images.filter(({ n }) => found.has(n)),
    gone: images.filter(({ n }) => !found.has(n)),
  }
}

// What goes to the agent from a draft: its words with the placeholders taken out (the rest
// exactly as written, but for the trimming of the ends), the images in the order of their
// placeholders, and where each stands in the words. Images with no placeholder in the draft
// are left out: `images` is the sent ones, never more than the draft holds.
export const splitDraft = (
  draft: string,
  images: readonly Attachment[],
): {
  readonly text: string
  readonly images: readonly Attachment[]
  readonly at: readonly number[]
} => {
  const found = placed(draft, images)
  const marks = [...found.values()].toSorted((a, b) => a.start - b.start)
  let text = ""
  let cursor = 0
  const offsets: number[] = []
  for (const mark of marks) {
    text += draft.slice(cursor, mark.start)
    offsets.push(text.length)
    cursor = mark.end
  }
  text += draft.slice(cursor)
  const lead = text.length - text.trimStart().length
  const trimmed = text.trim()
  return {
    text: trimmed,
    images: marks.map(({ n }) => images.find((image) => image.n === n)!),
    at: offsets.map((offset) => Math.min(Math.max(0, offset - lead), trimmed.length)),
  }
}

// Words that came back out of the agent, with the images that stood in them at `at` (all at
// the start where it is absent), as a draft: the placeholders typed in at their places, the
// images numbered from 1 in their order.
export const withMarks = (
  words: string,
  images: readonly Attachment[],
  at: readonly number[] | undefined,
): { readonly text: string; readonly images: readonly Attachment[] } => {
  const numbered = images.map((image, index) => ({ ...image, n: index + 1 }))
  let text = ""
  let cursor = 0
  let spaced = false
  // A space where a placeholder and the words after it would run together.
  const add = (next: string): void => {
    if (next === "") return
    if (spaced && !/^\s/.test(next) && text !== "" && !/\s$/.test(text)) text += " "
    spaced = false
    text += next
  }
  numbered.forEach((image, index) => {
    const offset = Math.min(Math.max(at?.[index] ?? 0, cursor), words.length)
    add(words.slice(cursor, offset))
    cursor = offset
    if (text !== "" && !/\s$/.test(text)) text += " "
    text += markOf(image.n)
    spaced = true
  })
  add(words.slice(cursor))
  return { text, images: numbered }
}

// The words with a placeholder added at the start for each of `images` they hold none for.
export const withMissingMarks = (
  words: string,
  images: readonly Attachment[],
  join: (earlier: string, later: string) => string,
): string => {
  const found = placed(words, images)
  const lacking = images.filter(({ n }) => !found.has(n))
  if (lacking.length === 0) return words
  const marks = lacking.map(({ n }) => markOf(n)).join(" ")
  return words === "" ? marks : join(marks, words)
}

// Several drafts that come back together, each with its images numbered as it had them, as
// the words of one: `text` in order, joined by `join`, the images numbered from `base` + 1
// without repeats. An image of the same file as an earlier one is let go, its placeholder
// with it. A placeholder is added at the start for an image the words hold none for.
export const gathered = (
  parts: readonly { readonly text: string; readonly images: readonly Attachment[] }[],
  base: number,
  join: (earlier: string, later: string) => string,
): { readonly text: string; readonly images: readonly Attachment[] } => {
  const paths = new Set<string>()
  const images: Attachment[] = []
  let text = ""
  for (const part of parts) {
    let words = part.text
    const mine: Attachment[] = []
    const earlier = new Set(paths)
    for (const image of part.images) {
      if (image.path !== null && earlier.has(image.path)) {
        words = withoutMark(words, image.n)
        continue
      }
      if (image.path !== null) paths.add(image.path)
      mine.push(image)
    }
    const found = placed(words, mine)
    const renamed = mine.map((image, index) => ({ ...image, n: base + images.length + index + 1 }))
    // Back to front, so the offsets of those before hold.
    const edits = renamed
      .flatMap(({ n }, index) => {
        const mark = found.get(mine[index]!.n)
        return mark ? [{ mark, n }] : []
      })
      .toSorted((a, b) => b.mark.start - a.mark.start)
    for (const { mark, n } of edits)
      words = `${words.slice(0, mark.start)}${markOf(n)}${words.slice(mark.end)}`
    // An image the words hold no placeholder for leads them.
    words = withMissingMarks(
      words,
      renamed.filter((_, index) => !found.has(mine[index]!.n)),
      join,
    )
    text = text === "" ? words : words === "" ? text : join(text, words)
    images.push(...renamed)
  }
  return { text, images }
}

// The draft and images after `back` came back ahead of them, no more than `max` images in all:
// those over are let go, from the end, their placeholders with them. `back` is numbered from
// 1 and renumbered to follow the draft's own.
export const comeBack = (
  back: { readonly text: string; readonly images: readonly Attachment[] },
  draft: string,
  images: readonly Attachment[],
  max: number,
  join: (earlier: string, later: string) => string,
): {
  readonly draft: string
  readonly images: readonly Attachment[]
  readonly over: readonly Attachment[]
} => {
  const base = nextMark(draft, images) - 1
  const fresh = gathered([back], base, join)
  const all = [...fresh.images, ...images]
  const kept = all.slice(0, max)
  const over = all.slice(max)
  // Words taken back whose placeholders a joining dropped are marked again, ahead of them.
  let text = withMissingMarks(fresh.text === "" ? draft : join(fresh.text, draft), kept, join)
  for (const image of over) text = withoutMark(text, image.n)
  return { draft: text, images: kept, over }
}

// The draft after Backspace (caret right after a placeholder, or the space after it) or Delete
// (caret right before one) at `start`..`end`, the whole placeholder gone, and where the caret
// goes; null where the key has no placeholder to take, and the field edits as it would.
export const unitEdit = (
  draft: string,
  start: number,
  end: number,
  key: "Backspace" | "Delete" | string,
  images: readonly Attachment[],
): { readonly text: string; readonly caret: number } | null => {
  if (start !== end || (key !== "Backspace" && key !== "Delete")) return null
  for (const mark of placed(draft, images).values()) {
    const spaced = draft[mark.end] === " "
    const lone = mark.start === 0 || /\s/.test(draft[mark.start - 1]!)
    let to: number
    if (key === "Backspace" && start === mark.end) to = mark.end + (spaced && lone ? 1 : 0)
    else if (key === "Backspace" && start === mark.end + 1 && spaced) to = mark.end + 1
    else if (key === "Delete" && start === mark.start) to = mark.end + (spaced && lone ? 1 : 0)
    else continue
    return { text: draft.slice(0, mark.start) + draft.slice(to), caret: mark.start }
  }
  return null
}

// An edit from `before` to `after` that left only part of an image's placeholder, as the same
// draft without what was left of it, and where the caret goes; null where it left none.
export const cleaned = (
  before: string,
  after: string,
  images: readonly Attachment[],
): { readonly text: string; readonly caret: number } | null => {
  const most = Math.min(before.length, after.length)
  const ahead = (limit: number): number => {
    let n = 0
    while (n < limit && before[n] === after[n]) n += 1
    return n
  }
  const behind = (limit: number): number => {
    let n = 0
    while (n < limit && before[before.length - 1 - n] === after[after.length - 1 - n]) n += 1
    return n
  }
  // The edit as where it began and where it ended, which a repeat in the words makes
  // ambiguous: read from the front, or from the back.
  const readings = [
    (() => {
      const p = ahead(most)
      return { p, s: behind(most - p) }
    })(),
    (() => {
      const s = behind(most)
      return { p: ahead(most - s), s }
    })(),
  ]
  const marks = [...placed(before, images).values()]
  const cutsOf = ({ p, s }: { p: number; s: number }): [number, number][] => {
    const oldEnd = before.length - s
    const newEnd = after.length - s
    const cuts: [number, number][] = []
    for (const mark of marks) {
      if (!(mark.start < oldEnd && p < mark.end && (mark.start < p || mark.end > oldEnd))) continue
      if (mark.start < p) cuts.push([mark.start, p])
      if (mark.end > oldEnd) cuts.push([newEnd, newEnd + mark.end - oldEnd])
    }
    return cuts
  }
  // Left whole by either reading, whole placeholders went and no part of one is left.
  if (readings.some((reading) => cutsOf(reading).length === 0)) return null
  const reading = readings[0]!
  const cuts = cutsOf(reading)
  const newEnd = after.length - reading.s
  let text = after
  let caret = newEnd
  for (const [from, to] of cuts.toSorted((a, b) => b[0] - a[0])) {
    text = text.slice(0, from) + text.slice(to)
    if (from < caret) caret -= Math.min(to, caret) - from
  }
  return { text, caret }
}
