import type { ChatAnswer, ChatRequest } from "../../model/conversation"
import { isAgentProgram } from "../../model/process"
import { shellCommand } from "../../model/prompt-refusal"
import type { TerminalMetadata } from "../../model/types"
import { chatAnswer, oneLine } from "./answers"

// A value kept for some terminals, by session context and terminal id; a terminal without
// one has no entry, and a context without terminals none either.
type ByTerminal<T> = Readonly<Record<string, Readonly<Record<string, T>>>>

const valueOf = <T>(map: ByTerminal<T>, context: string, id: string): T | undefined =>
  map[context]?.[id]

// The map with the terminal's value set, or dropped where it is undefined; the same map
// where that changes nothing, as `same` judges.
const withValue = <T>(
  map: ByTerminal<T>,
  context: string,
  id: string,
  value: T | undefined,
  same: (a: T | undefined, b: T | undefined) => boolean = Object.is,
): ByTerminal<T> => {
  if (same(valueOf(map, context, id), value)) return map
  if (value !== undefined) return { ...map, [context]: { ...map[context], [id]: value } }
  const { [id]: _gone, ...left } = map[context]!
  const { [context]: _session, ...rest } = map
  return Object.keys(left).length > 0 ? { ...rest, [context]: left } : rest
}

// Whether a terminal has a conversation to show: an agent runs in it, as its status says
// or, where Novadeck hears nothing from the agent (Antigravity without hooks), as its
// foreground program does. Once the agent ends, so does the chat.
export const chatAvailable = (terminal: TerminalMetadata): boolean =>
  terminal.state === "running" && (terminal.agent !== undefined || isAgentProgram(terminal.process))

// Whether a terminal's chat is kept: while an agent runs, and through a restart
// (`starting`, as when the runner is reached again), which says nothing of whether the
// agent is gone. They go once the terminal settles on something
// else, or closes.
export const chatKept = (terminal: TerminalMetadata): boolean =>
  chatAvailable(terminal) || terminal.state === "starting"

// The terminals showing their screen though the chat view is on, by the session context
// (`${projectId}/${workspaceSessionId}`) that holds them: the person went to answer their
// agent there. None of it outlives the page.
export type TerminalAnswers = ByTerminal<true>

export const noTerminalAnswers: TerminalAnswers = {}

export const answeringInTerminal = (
  answers: TerminalAnswers,
  context: string,
  id: string,
): boolean => answers[context]?.[id] === true

export const setAnsweringInTerminal = (
  answers: TerminalAnswers,
  context: string,
  id: string,
  on: boolean,
): TerminalAnswers => {
  const next = withValue(answers, context, id, on ? true : undefined)
  // None left is none at all, which spares the watcher its work.
  return Object.keys(next).length > 0 ? next : noTerminalAnswers
}

// Keeps only the terminals that `keep` says are still answered in.
export const keepTerminalAnswers = (
  answers: TerminalAnswers,
  keep: (context: string, id: string) => boolean,
): TerminalAnswers => {
  let next = answers
  for (const [context, ids] of Object.entries(answers))
    for (const id of Object.keys(ids))
      if (!keep(context, id)) next = setAnsweringInTerminal(next, context, id, false)
  return next
}

// Whether a terminal shows its agent's conversation rather than its screen: the chat view
// is on, an agent runs in it, and the person hasn't gone to its screen to answer it.
export const chatShown = (
  chatView: boolean,
  answers: TerminalAnswers,
  context: string,
  terminal: TerminalMetadata,
): boolean =>
  chatView && chatAvailable(terminal) && !answeringInTerminal(answers, context, terminal.id)

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
export type ChatReply = { readonly request: string; readonly dialog: string }
export type ChatReplyTo = ChatReply | "held"

// The answer a reply sends: its words for the question's own field, which takes one line.
export const replyAnswer = (to: ChatReply, text: string): ChatAnswer =>
  chatAnswer(to.dialog, oneLine(text))

export type ChatReplies = ByTerminal<ChatReplyTo>

export const noChatReplies: ChatReplies = {}

export const chatReplyOf = (
  replies: ChatReplies,
  context: string,
  id: string,
): ChatReplyTo | null => valueOf(replies, context, id) ?? null

export const sameReply = (
  a: ChatReplyTo | null | undefined,
  b: ChatReplyTo | null | undefined,
): boolean =>
  (a ?? null) === (b ?? null) ||
  (a != null &&
    b != null &&
    a !== "held" &&
    b !== "held" &&
    a.request === b.request &&
    a.dialog === b.dialog)

export const setChatReply = (
  replies: ChatReplies,
  context: string,
  id: string,
  to: ChatReplyTo | null,
): ChatReplies => withValue(replies, context, id, to ?? undefined, sameReply)

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

// What a terminal's chat box does with its words:
// - `message`: sends them as a prompt; `shell` as a shell command, as they start with `!`;
// - `reply`: answers the agent's question in that question's own field;
// - `held`: holds words written as a reply whose question went, until the person edits
//   them, so they never go as a message unread;
// - `waiting`: a reply whose agent's requests aren't read yet, as when the chat comes back
//   on screen, which waits for them before anything goes.
export type ComposerMode = "message" | "shell" | "reply" | "held" | "waiting"

// Whether the question a reply answers is still asked, its dialog the same and taking the
// words in its own field.
export const replyOpen = (to: ChatReplyTo | null, requests: readonly ChatRequest[]): boolean =>
  to !== null &&
  to !== "held" &&
  requests.some(
    (request) =>
      request.id === to.request &&
      !request.answered &&
      request.dialog?.type === "questions" &&
      request.dialog.id === to.dialog &&
      request.dialog.chat === "field",
  )

// The box's mode, from its draft, what the draft replies to, the agent's requests, and
// whether those are read yet (`loaded`).
export const composerState = (
  draft: string,
  replyTo: ChatReplyTo | null,
  requests: readonly ChatRequest[],
  loaded: boolean,
): ComposerMode => {
  if (replyTo !== null && replyTo !== "held") {
    if (!loaded) return "waiting"
    if (replyOpen(replyTo, requests)) return "reply"
  }
  if (replyTo !== null && draft.trim() !== "") return "held"
  return shellCommand(draft) !== undefined ? "shell" : "message"
}

// Words on their way to a terminal's agent: the draft they were sent from, as typed, which
// goes back in the box should they not arrive, and the question they answer, for a reply.
export type ChatSend = { readonly draft: string; readonly to: ChatReply | null }

// The words on their way to each terminal's agent, by session context and terminal id:
// taken out of the draft as they go. A terminal sends one at a time.
export type ChatSends = ByTerminal<ChatSend>

export const noChatSends: ChatSends = {}

export const chatSendOf = (sends: ChatSends, context: string, id: string): ChatSend | null =>
  valueOf(sends, context, id) ?? null

export const setChatSend = (
  sends: ChatSends,
  context: string,
  id: string,
  send: ChatSend | null,
): ChatSends => withValue(sends, context, id, send ?? undefined)
