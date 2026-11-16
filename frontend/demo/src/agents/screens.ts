import type { ChatSlice, ChatSliceRun } from "@novadeck/core/conversation"

// Agents' screens as the runner would hand them to a chat with nothing to show, for the debug
// panel's states. They live here, as the demo's styled runs name this folder's Tailwind guard.

const plain = (text: string, width: number): ChatSliceRun => ({
  text,
  width,
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
})

const view = (rows: readonly string[]): ChatSlice => ({
  reason: "view",
  columns: 60,
  rows: rows.map((text) => [plain(text, 60)]),
  cursor: null,
  secret: false,
})

// A dialog of the agent's own that no adapter reads, as it stands on the screen.
export const unreadDialogScreen: ChatSlice = view([
  "Do you trust the files in this folder?",
  "",
  "❯ 1. Yes, proceed",
  "  2. No, exit",
  "",
  "Enter to confirm · Esc to cancel",
])

// The agent's screen at its idle, where there is nothing else to see.
export const idleScreen: ChatSlice = view(["Welcome to the agent.", "", "❯ "])
