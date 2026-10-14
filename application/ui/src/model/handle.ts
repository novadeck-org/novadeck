// A handle as people see and say it: the word the runner gave a terminal, led by `@`.
// Stored and sent bare, so only what is shown goes through here.
export const handleText = (handle: string): string => `@${handle}`

// How a screen reader names a terminal on its controls: its name, then its handle, since
// names repeat ("Terminal") and the handle is what tells them apart. A window has none.
export const terminalLabel = (name: string, handle?: string): string =>
  handle ? `${name}, ${handleText(handle)}` : name
