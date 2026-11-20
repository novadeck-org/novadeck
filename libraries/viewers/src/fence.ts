// Which lines of a Markdown text are fenced code, for the readers that look for headings or tables
// in a text without parsing it whole. A fence opens with three or more backticks or tildes and
// closes only on a line of the same character, at least as many; shorter runs and the other
// character inside it are code (as the chat's blocks read them, `markdown-blocks.ts`). A backtick
// fence's info string holds no backtick (a line of ```a``` is inline code); a tilde fence's may. One
// that is never closed runs to the end of the text.
//
// A fence is indented by at most three spaces, as CommonMark has it; deeper is indented code, which
// fences nothing. Inside a list item it sits deeper, with the item's own indent: after a list
// item's line a fence may be indented as far as it likes, and closes at up to three spaces more
// than it opened.

const opening = /^( *)(?:(`{3,})[^`]*|(~{3,}).*)$/
const listItem = /^ *(?:[-*+]|\d{1,9}[.)])(?: |\t|$)/

/** For each line, whether it is a fence line or inside a fence: no heading or table starts there. */
export const fencedLines = (lines: readonly string[]): boolean[] => {
  let closing: RegExp | undefined
  // Whether a list item's line has come, and no line of the text's own margin since.
  let inList = false
  return lines.map((line) => {
    if (closing) {
      if (closing.test(line)) closing = undefined
      return true
    }
    const found = opening.exec(line)
    if (found && (found[1]!.length <= 3 || inList)) {
      const marker = (found[2] ?? found[3])!
      closing = new RegExp(`^ {0,${found[1]!.length + 3}}${marker[0]}{${marker.length},}[ \\t]*$`)
      return true
    }
    if (listItem.test(line)) inList = true
    else if (line.trim() !== "" && !line.startsWith(" ") && !line.startsWith("\t")) inList = false
    return false
  })
}
