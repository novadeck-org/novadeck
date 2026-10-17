// A plan is whatever Markdown the agent wrote. Novadeck cannot dictate its shape: it shows
// the file's text and derives only what the text itself says.

// The document's title is its first top-level heading, or failing that its file name.
export const titleOf = (path: string, text: string): string =>
  /^# (.+)$/m.exec(text)?.[1]?.trim() ?? path.split("/").at(-1) ?? path
