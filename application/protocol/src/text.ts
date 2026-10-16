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
