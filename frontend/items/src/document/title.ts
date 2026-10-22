// A document is whatever Markdown its writer wrote, a plan's agent or a file's. Novadeck
// cannot dictate its shape: it shows the text and derives only what the text itself says.

// The document's title is its first top-level heading, or failing that its file name.
export const titleOf = (path: string, text: string): string =>
  /^# (.+)$/m.exec(text)?.[1]?.trim() ?? path.split("/").at(-1) ?? path
