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

// Words a pane drafts for the person to look over, set after the draft as a paragraph of their
// own; null where the draft is a shell command, which they would only be more lines of and
// which a pane has no business before. Words the draft holds already aren't added again.
export const toldDraft = (draft: string, words: string): string | null => {
  if (!draft.trim()) return words
  if (draft.trimStart().startsWith("!")) return null
  return draft.includes(words) ? draft : `${draft}\n\n${words}`
}

// Whether words taken out of the agent's box and what the chat's holds make one draft: not a
// shell command and a message, as the message would run as more of the command, or the command
// go out as words.
export const mixes = (taken: string, draft: string): boolean =>
  !draft.trim() || taken.trimStart().startsWith("!") === draft.trimStart().startsWith("!")

const compact = (text: string): string => text.replace(/\s+/g, "")

// Whether the draft holds these words already, whole or as its first or last paragraph: a paste
// that landed in the agent's box though it was never seen to, whose words stayed here too.
const holds = (draft: string, words: string): boolean => {
  const own = compact(words)
  const paragraphs = draft.split(/\n\s*\n/)
  return [draft, paragraphs[0] ?? "", paragraphs.at(-1) ?? ""].some((part) => compact(part) === own)
}

// Words taken out of the agent's box and what the chat's holds, as they would have gone out: the
// box's first, then a blank line, then the chat's. Words it holds already aren't added. Those
// that don't mix, as the person wrote while they came, go as `joinDraft` joins them, so that no
// message runs as a command.
export const takenDraft = (taken: string, draft: string): string => {
  if (!draft.trim()) return taken
  if (holds(draft, taken)) return draft
  const both = taken.trimStart().startsWith("!") && draft.trimStart().startsWith("!")
  return mixes(taken, draft) && !both ? `${taken}\n\n${draft}` : joinDraft(taken, draft)
}

// Words typed ahead into the agent's box as it started, and what the person typed on in the
// chat as it came: one run of keys, the chat's going on from the box's as typed. Words the draft
// holds already aren't added, as `takenDraft` leaves them.
export const typedOn = (taken: string, draft: string): string =>
  draft.trim() && holds(draft, taken) ? draft : `${taken}${draft}`
