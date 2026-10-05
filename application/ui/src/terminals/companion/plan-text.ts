// A plan is whatever Markdown the agent wrote. Novadeck cannot dictate its shape: it shows
// the file's text and derives only what the text itself says.

// The document's title is its first top-level heading, or failing that its file name.
export const titleOf = (path: string, text: string): string =>
  /^# (.+)$/m.exec(text)?.[1]?.trim() ?? path.split("/").at(-1) ?? path

// Headings below the title, with where each starts in the text. Fenced code is skipped,
// since a `#` there isn't a heading.
export const headingsOf = (text: string): { text: string; at: number }[] => {
  const headings: { text: string; at: number }[] = []
  let fenced = false
  let at = 0
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced
    const heading = !fenced && /^#{2,3} (.+)$/.exec(line)
    if (heading) headings.push({ text: heading[1]!.trim(), at })
    at += line.length + 1
  }
  return headings
}
