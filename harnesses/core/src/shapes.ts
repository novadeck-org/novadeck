/**
 * The shapes of a harness's transcript records, and whether its chat decoder reads each.
 *
 * Each decoder keeps two lists: the shapes it reads, and the shapes it skips knowingly
 * (thinking, metadata, context the harness adds as the person's words). A shape on neither
 * list is unknown: a harness release wrote something the decoder has never seen, which it
 * drops without a word. Keys go deep enough to catch a prompt hidden under a record the
 * decoder skips on purpose, as #482's was, in an attachment subtype of a skipped record:
 * a record's type, then its subtype or content block, and a leading `<tag>` in the person's
 * text, which is how harnesses wrap what isn't the person's own words.
 *
 * The e2e suite fails a test whose transcripts hold an unknown shape, and
 * `scripts/transcripts/shapes.ts` runs the lists over a developer's own history.
 */

/** Whether a decoder reads a shape, skips it knowingly, or has never seen it. */
export type ShapeVerdict = "read" | "skipped" | "unknown"

/** One shape a transcript line holds, by its key (`record:user`, `tag:command-name`, …). */
export type Shape = { readonly key: string; readonly verdict: ShapeVerdict }

/** A decoder's lists: the shapes it reads and the ones it skips knowingly. */
export type ShapeLists = { readonly read: readonly string[]; readonly skipped: readonly string[] }

/**
 * Where a harness keeps the transcripts its decoder reads: a folder under its home, and the
 * files there that are transcripts, by their path below that folder.
 */
export type TranscriptStore = { readonly folder: string; readonly file: RegExp }

/** The shapes of keys by the lists: each key once, in order. */
export const classify =
  (lists: ShapeLists) =>
  (keys: readonly string[]): readonly Shape[] => {
    const read = new Set(lists.read)
    const skipped = new Set(lists.skipped)
    return [...new Set(keys)].map((key) => ({
      key,
      verdict: read.has(key) ? "read" : skipped.has(key) ? "skipped" : "unknown",
    }))
  }

// A tag that opens a text, after any blank space: `<command-name>`, `<pasted_content id=…>`.
const opening = /^\s*<([A-Za-z_][\w.:-]*)[\s>]/

/**
 * The name of the tag a text opens with and closes further on, as a harness wraps text in:
 * undefined for text that opens with no tag, or with one it never closes (a lone `<div>`).
 */
export const leadingTag = (text: string): string | undefined => {
  const name = opening.exec(text)?.[1]
  return name !== undefined && new RegExp(`</${name.replace(/[.]/g, "\\.")}[\\s>]`).test(text)
    ? name
    : undefined
}

/** The key for a text's leading tag, or none. */
export const tagKeys = (text: string): readonly string[] => {
  const tag = leadingTag(text)
  return tag === undefined ? [] : [`tag:${tag}`]
}

/** The unknown shapes among the lines' shapes, each with how many lines held it. */
export const unknownShapes = (
  shapes: (line: string) => readonly Shape[],
  lines: Iterable<string>,
): ReadonlyMap<string, number> => {
  const found = new Map<string, number>()
  for (const line of lines)
    for (const shape of shapes(line))
      if (shape.verdict === "unknown") found.set(shape.key, (found.get(shape.key) ?? 0) + 1)
  return found
}
