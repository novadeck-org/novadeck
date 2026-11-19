import type { ChatBlock } from "@novadeck/core/conversation/turns"

// Folding long replies (Preferences > Experimental): an agent's reply is the last of its own words
// in a turn, what it says once it's done, not the lines it writes between calls or its thinking.
// Every reply but the latest may fold: the latest is what the person reads now, and it never folds
// under their eyes.

// The ids of the replies that may fold in `blocks`: each turn's last words of the agent, of the
// turns that ended, but the latest of them. A turn starts at a prompt (the person's or the
// doorbell's); the turn the agent still works on hasn't ended.
export const foldableReplies = (
  blocks: readonly ChatBlock[],
  working: boolean,
): ReadonlySet<string> => {
  const replies: string[] = []
  let last: string | null = null
  for (const block of blocks) {
    if (block.kind === "user" || block.kind === "doorbell") {
      if (last !== null) replies.push(last)
      last = null
    } else if (block.kind === "assistant" && !block.thinking) last = block.id
  }
  if (last !== null && !working) replies.push(last)
  return new Set(replies.slice(0, -1))
}

// Words this short never take enough lines to fold, so they're never measured: about 30 lines of
// prose at a chat's width.
const fewChars = 1_200
const fewLines = 30

// Whether a reply's words might run long enough to fold, before anything is measured.
export const mayFold = (text: string): boolean => {
  if (text.length >= fewChars) return true
  let lines = 1
  for (const char of text) if (char === "\n" && ++lines >= fewLines) return true
  return false
}
