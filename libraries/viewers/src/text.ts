// What a Markdown text says, without an editor: the markdown viewer is a heavy import, and
// an app that only lists a document's headings shouldn't load it. Nothing here imports
// CodeMirror, and nothing that does may be imported from here.

/** A heading below the title, and where it starts in the text. */
export type Heading = { readonly text: string; readonly at: number; readonly depth: 2 | 3 }

/**
 * The second- and third-level headings of a text, with where each starts. Fenced code is
 * skipped, since a `#` there isn't a heading.
 */
export const outline = (text: string): Heading[] => {
  const headings: Heading[] = []
  let fenced = false
  let at = 0
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced
    const heading = !fenced && /^(#{2,3}) (.+)$/.exec(line)
    if (heading) headings.push({ text: heading[2]!.trim(), at, depth: heading[1]!.length as 2 | 3 })
    at += line.length + 1
  }
  return headings
}
