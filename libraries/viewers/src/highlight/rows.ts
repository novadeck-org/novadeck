import { hashOf } from "../hash.js"
import type { HighlightedLine } from "./lines.js"

// Highlighting as the code and diff viewers draw it: the parsers loaded only once a viewer
// has something to highlight, a key for what they made, and their runs put on a viewer's
// rows.

export type { HighlightedLine, Run } from "./lines.js"

// The lines split into runs by kind of token, or null when the language isn't one the
// viewer highlights.
export const highlightLines = async (
  language: string,
  lines: readonly string[],
): Promise<readonly HighlightedLine[] | null> =>
  (await import("./lines.js")).highlightLines(language, lines)

// What names lines of `text` highlighted in a language, by a hash of the text, so a key
// never holds the text.
export const runsKey = (language: string, text: string): string =>
  `${language}\n${text.length}:${hashOf(text)}`

// Each line's runs in its row's text, the row's last element: a token in a span with its
// classes, plain text as it is. A row without its line's runs stays as it is.
export const paintRows = (
  rows: readonly HTMLElement[],
  lines: readonly (HighlightedLine | undefined)[],
): void => {
  rows.forEach((row, index) => {
    const runs = lines[index]
    const text = row.lastElementChild
    if (!runs || !text) return
    text.replaceChildren(
      ...runs.map((run) => {
        if (!run.classes) return run.text
        const span = text.ownerDocument.createElement("span")
        span.className = run.classes
        span.textContent = run.text
        return span
      }),
    )
  })
}
