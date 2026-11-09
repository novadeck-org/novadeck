/** The placeholder a harness shows for a pasted image, `[Image #N]`. */
const mark = /\[Image #\d+\]/g

/** A text without its white space: where a mark stood is told by what came before it, so that a box's own spacing around one doesn't count. */
export const compactLength = (text: string): number => text.replace(/\s+/g, "").length

/** A box's text told as its words and where the images stood among them (`splitImages`). */
export type Marked = {
  /** The words, the placeholders taken out, trimmed. */
  readonly words: string
  /** How many placeholders there were, wherever they stood. */
  readonly marks: number
  /**
   * For each, how many characters of the words came before it, white space not counted
   * (`compactLength`), so that Codex's space after a placeholder is no part of it.
   */
  readonly places: readonly number[]
}

/**
 * A box's text as its words and where the images stood: Claude Code and Codex show a pasted
 * image as `[Image #N]` at the cursor, so at the start of the box where it was pasted into an
 * empty one, or among the words where those were pasted first; and put the same text back when
 * a Stop takes a queued message into the box. Antigravity shows none, and for it a prompt
 * with images among its words types them itself, the same text. The numbers run on through a
 * session, so only how many is told.
 */
export const splitImages = (text: string): Marked => {
  const places: number[] = []
  let before = 0
  let words = ""
  let from = 0
  for (const found of text.matchAll(mark)) {
    const run = text.slice(from, found.index)
    words += run
    before += compactLength(run)
    places.push(before)
    from = found.index + found[0].length
  }
  words += text.slice(from)
  return { words: words.trim(), marks: places.length, places }
}
