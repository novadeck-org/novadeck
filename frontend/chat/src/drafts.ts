import { valueOf, withValue, type ByTerminal } from "./by-terminal"

// What the person has typed in a terminal's chat and not sent, by session context and
// terminal id. An empty draft is not kept.
export type ChatDrafts = ByTerminal<string>

export const noChatDrafts: ChatDrafts = {}

export const chatDraftOf = (drafts: ChatDrafts, context: string, id: string): string =>
  valueOf(drafts, context, id) ?? ""

export const setChatDraft = (
  drafts: ChatDrafts,
  context: string,
  id: string,
  text: string,
): ChatDrafts => withValue(drafts, context, id, text === "" ? undefined : text)

// Words joined to a draft, each on lines of its own: `later` after `earlier`, unless
// `earlier` is a shell command, which `later` would only make more lines of: then they go
// before it, which makes the draft a message to look over before it is sent again. Two shell
// commands make one of two lines, the second without its `!`, to look over before it runs.
export const joinDraft = (earlier: string, later: string): string => {
  if (!earlier.trim()) return later
  if (!later.trim()) return earlier
  if (!earlier.trimStart().startsWith("!")) return `${earlier}\n${later}`
  if (!later.trimStart().startsWith("!")) return `${later}\n${earlier}`
  return `${earlier}\n${later.trimStart().slice(1).trimStart()}`
}

// Words taken out of the agent's box and what the chat's holds, as they would have gone out: the
// box's first, then a blank line, then the chat's.
export const takenDraft = (taken: string, draft: string): string =>
  draft.trim() ? `${taken}\n\n${draft}` : taken
