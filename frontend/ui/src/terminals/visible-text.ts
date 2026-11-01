// Characters that draw as nothing or as blank space, or change how text is drawn, other than
// the plain ASCII space: Unicode spaces and separators, control and format characters (zero-
// width and direction controls, tag characters), every default-ignorable code point (the
// Braille and Hangul fillers, variation selectors, U+034F and the rest), unassigned code
// points and lone surrogates. A command shown for approval writes each as an escape, so none
// can hide text.
const invisible =
  /[\p{Zs}\p{Zl}\p{Zp}\p{Cc}\p{Cf}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u2800]/gu

// Runs of more than two combining marks, which stack into a smudge that can cover what
// follows.
const markRun = /\p{M}{3,}/gu

const escape = (char: string): string =>
  char === " " || char === "\n" || char === "\t"
    ? char
    : `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`

// `text` with every such character, other than an ASCII space, as `\u{2800}`, and long runs
// of combining marks written out. Newlines and tabs stay as they are.
export const visibleText = (text: string): string =>
  text.replace(markRun, (run) => [...run].map(escape).join("")).replace(invisible, escape)

// `text` made visible and cut to `max` characters, with an ellipsis where it was cut.
export const clipped = (text: string, max: number): string => {
  const shown = visibleText(text).replace(/\s+/g, " ").trim()
  return shown.length > max ? `${shown.slice(0, max - 1)}…` : shown
}
