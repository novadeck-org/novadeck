// Which lines of a Markdown text are fenced code, for the readers that look for headings or tables
// in a text without parsing it whole. A fence opens with three or more backticks or tildes and
// closes only on a line of the same character, at least as many; shorter runs and the other
// character inside it are code (as the chat's blocks read them, `markdown-blocks.ts`). One that
// is never closed runs to the end of the text.

const opening = /^\s*(`{3,}|~{3,})[^`]*$/

/** For each line, whether it is a fence line or inside a fence: no heading or table starts there. */
export const fencedLines = (lines: readonly string[]): boolean[] => {
  let closing: RegExp | undefined
  return lines.map((line) => {
    if (closing) {
      if (closing.test(line)) closing = undefined
      return true
    }
    const marker = opening.exec(line)?.[1]
    if (marker === undefined) return false
    closing = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`)
    return true
  })
}
