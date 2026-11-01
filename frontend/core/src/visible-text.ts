// Text as the person reads it (an AutoRun value, an agent's words), verbatim but for the characters nothing shows: control,
// format (bidi marks, zero-width characters, the byte order mark) and line separators are
// written as \u{…}, so a value can't look like another or hide a character.
export const visibleText = (value: string): string =>
  value.replaceAll(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (char) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`,
  )
