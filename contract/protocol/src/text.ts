/**
 * Characters that draw as nothing, or as a blank, though they aren't a plain space, tab or
 * line end: control and format characters, the ones Unicode says to ignore when drawing
 * (joiners, variation selectors, tags), unassigned code points, other spaces, and the
 * glyphs that draw blank (Braille's blank pattern, the null notehead). Between short runs
 * of spaces they wrap a line into blank rows, so part of a command could hide behind them.
 * One rule for the runner, which refuses them in a command an agent asks the person to
 * run, and the Inbox, which marks them in one a harness shows verbatim.
 */
export const hiddenCharacter =
  /(?![\t\n])[\p{Cc}\p{Cf}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{2800}\u{1d159}]|(?! )\p{Zs}/u

// A variation selector asking for an emoji's colour form, or making a keycap, draws as part
// of the character before it: legitimate there.
const emojiBase = /[\p{Extended_Pictographic}#*0-9]/u

/**
 * Whether the character at `index` of `text` (a code point's first unit) draws as nothing
 * there: `hiddenCharacter`, but for U+FE0F after an emoji or keycap base.
 */
export const hiddenAt = (text: string, index: number): boolean => {
  const char = String.fromCodePoint(text.codePointAt(index)!)
  if (!hiddenCharacter.test(char)) return false
  if (char !== "\u{fe0f}" || index === 0) return true
  const before = text.codePointAt(index - 1)!
  // The code point before it, stepping back over a surrogate pair.
  const base =
    index > 1 && before >= 0xdc00 && before <= 0xdfff
      ? String.fromCodePoint(text.codePointAt(index - 2)!)
      : String.fromCodePoint(before)
  return !emojiBase.test(base)
}

/** The first character of `text` that draws as nothing, as U+XXXX; undefined where none does. */
export const hiddenIn = (text: string): string | undefined => {
  for (let index = 0; index < text.length;) {
    const point = text.codePointAt(index)!
    if (hiddenAt(text, index)) return `U+${point.toString(16).toUpperCase().padStart(4, "0")}`
    index += point > 0xffff ? 2 : 1
  }
  return undefined
}

/** The most lines a command an agent asks the person to run may hold. */
export const maxCommandLines = 40

// Controls but the tab and the line feed: C0 (the carriage return too), DEL and C1, as the
// escapes a terminal takes as keys or sequences, U+009B among them.
const controls = "\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f"
// The marks that reorder text or hide in it: the bidirectional marks, embeddings, overrides
// and isolates, which can make a title read as something else; the zero-width space, the
// word joiner, the byte-order mark and the Mongolian vowel separator; and the line and
// paragraph separators. Not the zero-width joiner and non-joiner: emoji such as 👩‍💻 and
// scripts such as Persian need them, and they reorder nothing.
const directions = "\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069"
const marks = `${directions}\\u180e\\u200b\\u2028\\u2029\\u2060\\ufeff`

/**
 * A mark that changes the direction text reads in: the bidirectional marks, embeddings,
 * overrides and isolates. One of the marks `unsafeCharacter` takes in, which a refusal can
 * name apart.
 */
export const directionMark = new RegExp(`[${directions}]`)

/**
 * A control character other than the tab and the line feed: what an input box would take
 * as a key, and a terminal as part of an escape sequence.
 */
export const controlCharacter = new RegExp(`[${controls}]`)

/**
 * A character no text a person reads may hold: a `controlCharacter`, or a mark that reorders
 * text or hides in it. The one rule behind what the runner strips from an agent's Inbox
 * text, and (as `unsafeInLine`) what titles, Inbox lines, startup commands and notices
 * refuse.
 */
export const unsafeCharacter = new RegExp(`[${controls}${marks}]`)

/** An `unsafeCharacter`, or the tab or line feed: what one line may not hold. */
export const unsafeInLine = new RegExp(`[\\t\\n${controls}${marks}]`)

/** Text that is one line: none of it is what one line may not hold (`unsafeInLine`). */
export const oneLine = new RegExp(`^[^\\t\\n${controls}${marks}]*$`)

const unsafeInLineRuns = new RegExp(`[\\t\\n${controls}${marks}]+`, "g")

/** `text` as one line: each run of what one line may not hold (`unsafeInLine`) as a space, trimmed. */
export const asLine = (text: string): string => text.replace(unsafeInLineRuns, " ").trim()
