import { isAgentProgram } from "../../model/process"
import type { TerminalMetadata } from "../../model/types"

// Which terminals show their agent's conversation rather than their screen, by the
// session context (`${projectId}/${workspaceSessionId}`) that holds them. Nothing is kept
// for a terminal showing its screen, and none of it outlives the page.
export type ChatModes = Readonly<Record<string, Readonly<Record<string, true>>>>

export const noChatModes: ChatModes = {}

// Whether a terminal has a conversation to show: an agent runs in it, as its status says
// or, where Novadeck hears nothing from the agent (Antigravity without hooks), as its
// foreground program does. Once the agent ends, so does the chat.
export const chatAvailable = (terminal: TerminalMetadata): boolean =>
  terminal.state === "running" && (terminal.agent !== undefined || isAgentProgram(terminal.process))

// Whether a terminal's chat choice is kept: while an agent runs, and through a restart (`starting`, as when the runner is reached again), which says
// nothing of whether the agent is gone. They go once the terminal settles on something
// else, or closes.
export const chatKept = (terminal: TerminalMetadata): boolean =>
  chatAvailable(terminal) || terminal.state === "starting"

export const chatModeOn = (modes: ChatModes, context: string, id: string): boolean =>
  modes[context]?.[id] === true

export const setChatMode = (
  modes: ChatModes,
  context: string,
  id: string,
  on: boolean,
): ChatModes => {
  if (chatModeOn(modes, context, id) === on) return modes
  if (on) return { ...modes, [context]: { ...modes[context], [id]: true } }
  const { [id]: _off, ...left } = modes[context]!
  const { [context]: _session, ...rest } = modes
  return Object.keys(left).length > 0 ? { ...rest, [context]: left } : rest
}

// Keeps only the terminals that `keep` says still show a chat.
export const keepChatModes = (
  modes: ChatModes,
  keep: (context: string, id: string) => boolean,
): ChatModes => {
  let next = modes
  for (const [context, ids] of Object.entries(modes))
    for (const id of Object.keys(ids))
      if (!keep(context, id)) next = setChatMode(next, context, id, false)
  return next
}

// What the person has typed in a terminal's chat and not sent, by session context and
// terminal id. An empty draft is not kept.
export type ChatDrafts = Readonly<Record<string, Readonly<Record<string, string>>>>

export const noChatDrafts: ChatDrafts = {}

export const chatDraftOf = (drafts: ChatDrafts, context: string, id: string): string =>
  drafts[context]?.[id] ?? ""

export const setChatDraft = (
  drafts: ChatDrafts,
  context: string,
  id: string,
  text: string,
): ChatDrafts => {
  if (chatDraftOf(drafts, context, id) === text) return drafts
  if (text !== "") return { ...drafts, [context]: { ...drafts[context], [id]: text } }
  const { [id]: _gone, ...left } = drafts[context]!
  const { [context]: _session, ...rest } = drafts
  return Object.keys(left).length > 0 ? { ...rest, [context]: left } : rest
}

// Keeps only the drafts of terminals that `keep` says still show a chat.
export const keepChatDrafts = (
  drafts: ChatDrafts,
  keep: (context: string, id: string) => boolean,
): ChatDrafts => {
  let next = drafts
  for (const [context, ids] of Object.entries(drafts))
    for (const id of Object.keys(ids))
      if (!keep(context, id)) next = setChatDraft(next, context, id, "")
  return next
}

// The question a terminal's chat box replies to, by session context and terminal id: a
// request's dialog while the person replies to it there, or "held" once it went with the
// words still in the box, which then wait for the person's edit. Kept beside the draft, so
// it outlives the chat leaving the screen as the draft does; none is not kept.
export type ChatReplyTo = { readonly request: string; readonly dialog: string } | "held"

export type ChatReplies = Readonly<Record<string, Readonly<Record<string, ChatReplyTo>>>>

export const noChatReplies: ChatReplies = {}

export const chatReplyOf = (
  replies: ChatReplies,
  context: string,
  id: string,
): ChatReplyTo | null => replies[context]?.[id] ?? null

const sameReply = (a: ChatReplyTo | null, b: ChatReplyTo | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a !== "held" &&
    b !== "held" &&
    a.request === b.request &&
    a.dialog === b.dialog)

export const setChatReply = (
  replies: ChatReplies,
  context: string,
  id: string,
  to: ChatReplyTo | null,
): ChatReplies => {
  if (sameReply(chatReplyOf(replies, context, id), to)) return replies
  if (to !== null) return { ...replies, [context]: { ...replies[context], [id]: to } }
  const { [id]: _gone, ...left } = replies[context]!
  const { [context]: _session, ...rest } = replies
  return Object.keys(left).length > 0 ? { ...rest, [context]: left } : rest
}

// Keeps only the replies of terminals that `keep` says still show a chat.
export const keepChatReplies = (
  replies: ChatReplies,
  keep: (context: string, id: string) => boolean,
): ChatReplies => {
  let next = replies
  for (const [context, ids] of Object.entries(replies))
    for (const id of Object.keys(ids))
      if (!keep(context, id)) next = setChatReply(next, context, id, null)
  return next
}

// Settles what a terminal's draft replies to once its agent ended, the terminal still
// there: a question asked by that agent is gone for good, so words written for it are held
// for the person's edit, and with no words the reply goes. A held reply stays held.
export const settleChatReplies = (
  replies: ChatReplies,
  drafts: ChatDrafts,
  ended: (context: string, id: string) => boolean,
): ChatReplies => {
  let next = replies
  for (const [context, ids] of Object.entries(replies))
    for (const [id, to] of Object.entries(ids))
      if (to !== "held" && ended(context, id))
        next = setChatReply(
          next,
          context,
          id,
          chatDraftOf(drafts, context, id).trim() === "" ? null : "held",
        )
  return next
}
