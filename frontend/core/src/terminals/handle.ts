import type { TerminalMetadata, TerminalStatus } from "../types"

// A handle as people see and say it: the word the runner gave a terminal, led by `@`.
// Stored and sent bare, so only what is shown goes through here.
export const handleText = (handle: string): string => `@${handle}`

// How a screen reader names a terminal on its controls: its name, then its handle, since
// names repeat ("Terminal") and the handle is what tells them apart. A window has none.
export const terminalLabel = (name: string, handle?: string): string =>
  handle ? `${name}, ${handleText(handle)}` : name

// Whether a terminal's tab shows its handle at rest: where an agent runs or has run, or
// where an agent opened it or leads it, as these are the terminals agents and their
// notices name by handle. A shell the person opened that no agent touched keeps it out
// of the way, in its label, the switcher and search.
export const showsHandle = (
  terminal: Pick<TerminalMetadata, "agentRan" | "openedBy" | "ledBy"> & TerminalStatus,
): boolean =>
  Boolean(
    terminal.agentRan ||
    terminal.openedBy ||
    terminal.ledBy ||
    (terminal.state === "running" && terminal.agent),
  )
