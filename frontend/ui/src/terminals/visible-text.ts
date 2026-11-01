// Characters that draw as nothing or as blank space, or change how text is drawn, other than
// the plain ASCII space: Unicode spaces and separators, format characters (zero-width and
// direction controls, tag characters), the blank Braille and Hangul fillers, and variation
// selectors. A command shown for approval writes each as an escape, so none can hide text.
const invisible = /[\p{Zs}\p{Zl}\p{Zp}\p{Cf}\p{Cc}⠀ㅤᅟᅠﾠ\p{Variation_Selector}]/gu

// `text` with every such character, other than an ASCII space, as `\u{2800}`. Newlines and
// tabs stay as they are.
export const visibleText = (text: string): string =>
  text.replace(invisible, (char) =>
    char === " " || char === "\n" || char === "\t"
      ? char
      : `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`,
  )

// `text` made visible and cut to `max` characters, with an ellipsis where it was cut.
export const clipped = (text: string, max: number): string => {
  const shown = visibleText(text).replace(/\s+/g, " ").trim()
  return shown.length > max ? `${shown.slice(0, max - 1)}…` : shown
}
