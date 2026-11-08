import { valueOf, withValue, type ByTerminal } from "./by-terminal"
import type { SentShell } from "./history"

// The shell commands sent from each terminal's chat, oldest first, by session context and
// terminal id: the backend keeps no receipt of one, and not every harness records it, so the
// history keeps them here. Only the latest few are of use.
export type ChatShells = ByTerminal<readonly SentShell[]>

export const noChatShells: ChatShells = {}

const none: readonly SentShell[] = []

// How many a terminal keeps.
const kept = 50

export const chatShellsOf = (
  shells: ChatShells,
  context: string,
  id: string,
): readonly SentShell[] => valueOf(shells, context, id) ?? none

export const withShell = (
  shells: ChatShells,
  context: string,
  id: string,
  shell: SentShell,
): ChatShells =>
  withValue(shells, context, id, [...chatShellsOf(shells, context, id), shell].slice(-kept))
