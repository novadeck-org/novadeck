import type { AgentMessage, MessageThread, TerminalThreads } from "@novadeck/core/messages"

// A terminal's messages as the pane reads them: a list of its conversations, each one
// other terminal's thread with it or the person's entries, and one opened as a chat.

// One conversation: every thread the terminal had with one other, keyed by its handle (the
// runner starts a new thread for a pair after ten quiet minutes), or, keyed `you`, every
// entry its agent wrote the person with their replies, which the runner keeps as a thread
// an entry. Its messages oldest first; for each of the person's replies, the question it
// answers.
export type Conversation = {
  readonly key: string
  readonly peer: string
  readonly messages: readonly AgentMessage[]
  readonly asked: ReadonlyMap<string, AgentMessage>
}

export const youKey = "you"

export const conversationsOf = (terminal: TerminalThreads): readonly Conversation[] => {
  const byPeer = new Map<string, MessageThread[]>()
  for (const thread of terminal.threads)
    byPeer.set(thread.peer, [...(byPeer.get(thread.peer) ?? []), thread])
  return [...byPeer].map(([peer, threads]): Conversation => {
    const asked = new Map<string, AgentMessage>()
    for (const thread of threads) {
      const ask = thread.messages.find((message) => message.inbox === "ask")
      if (!ask) continue
      for (const message of thread.messages)
        if (message.inbox === "answer") asked.set(message.id, ask)
    }
    const messages =
      threads.length === 1
        ? threads[0]!.messages
        : threads.flatMap((thread) => thread.messages).toSorted((a, b) => a.sentAt - b.sentAt)
    return { key: peer === "you" ? youKey : peer, peer, messages, asked }
  })
}

export const latestOf = (conversation: Conversation): number =>
  conversation.messages.at(-1)?.sentAt ?? 0

// The open entries of a kind; news (`"tell"`) counts a done report, which is a tell that says
// the task is finished.
const openEntries = (conversation: Conversation, kind: "ask" | "tell"): number =>
  conversation.messages.filter(
    (message) =>
      (message.inbox === kind || (kind === "tell" && message.inbox === "done")) &&
      message.inboxState === "open",
  ).length

// The questions the person hasn't answered yet.
export const openAsks = (conversation: Conversation): number => openEntries(conversation, "ask")

// What a row's corner says, one thing: that the agent asks the person something, that its
// last message was lost, that there's news since the person last looked (`seenAt`), or else
// when its last message came. The person's entries say news by their own unread state, an
// agent's by any message from it since.
export type Corner =
  | { readonly kind: "asks" }
  | { readonly kind: "undelivered" }
  | { readonly kind: "unread" }
  | { readonly kind: "time"; readonly at: number }

export const cornerOf = (conversation: Conversation, seenAt: number): Corner => {
  const last = conversation.messages.at(-1)
  const you = conversation.key === youKey
  if (you && openAsks(conversation)) return { kind: "asks" }
  if (last?.state === "gone") return { kind: "undelivered" }
  const news = you
    ? openEntries(conversation, "tell") > 0
    : conversation.messages.some(
        (message) => message.from === conversation.peer && message.sentAt > seenAt,
      )
  return news ? { kind: "unread" } : { kind: "time", at: last?.sentAt ?? 0 }
}

// Whether the person's entries wait on them: a question open or news unread.
export const waitsOnPerson = (conversation: Conversation): boolean =>
  conversation.key === youKey &&
  (openAsks(conversation) > 0 || openEntries(conversation, "tell") > 0)

// The list: the person's entries first while they wait on them, then latest first.
export const listed = (conversations: readonly Conversation[]): readonly Conversation[] =>
  conversations.toSorted(
    (a, b) => Number(waitsOnPerson(b)) - Number(waitsOnPerson(a)) || latestOf(b) - latestOf(a),
  )

// How an entry says what it is, in plain words, by its kind and where it stands.
export const entryLabel = (message: AgentMessage): string | undefined => {
  if (message.inbox === "tell") return message.inboxState === "open" ? "Tells you" : "Told you"
  if (message.inbox === "done")
    return message.inboxState === "open" ? "Reports done" : "Reported done"
  if (message.inbox !== "ask") return undefined
  switch (message.inboxState) {
    case "open":
      return "Asks you"
    case "answered":
      return "Asked you · answered"
    case "withdrawn":
      return "Asked you · withdrawn"
    case "gone":
      return "Asked you · session ended"
    case "undelivered":
      return "Asked you · reply not delivered"
    default:
      return "Asked you"
  }
}

// What a message says of where it is, only while that's worth a look: on its way (`queued`,
// as one held waits too, or `leased`), lost (`gone`), or `delivered` under the last one of
// the right-hand side's.
export type Note = "queued" | "leased" | "gone" | "delivered"

// A chat, top to bottom: the time where a burst starts (the first message, or one after ten
// quiet minutes), a New line before the first of the person's unread entries, rounds that
// repeat folded to one line, and the messages, each on its side, grouped under the one
// before it from the same sender.
export type ChatEntry =
  | { readonly kind: "time"; readonly key: string; readonly at: number }
  | { readonly kind: "new"; readonly key: string }
  | {
      readonly kind: "fold"
      readonly key: string
      readonly rounds: number
      readonly first: AgentMessage
    }
  | {
      readonly kind: "message"
      readonly key: string
      readonly message: AgentMessage
      // The right side is the terminal's own agent's, or the person's in their entries.
      readonly side: "out" | "in"
      readonly grouped: boolean
      readonly note: Note | null
    }

export const burstMs = 10 * 60_000

// Whether two messages say the same, numbers aside, from the same sender.
const same = (a: AgentMessage, b: AgentMessage): boolean =>
  a.from === b.from && a.text.replace(/\d+/g, "#") === b.text.replace(/\d+/g, "#")

// Rounds of two messages that come again: three or more of the same round fold, all but the
// last, which stays in full, so a loop shows as one; never over a message still on its way
// or lost.
type Run =
  | { readonly message: AgentMessage }
  | { readonly fold: readonly AgentMessage[]; readonly rounds: number }

export const foldRounds = (messages: readonly AgentMessage[]): readonly Run[] => {
  const runs: Run[] = []
  let at = 0
  while (at < messages.length) {
    let rounds = 1
    while (
      messages[at + 2 * rounds + 1] &&
      same(messages[at + 2 * rounds]!, messages[at]!) &&
      same(messages[at + 2 * rounds + 1]!, messages[at + 1]!)
    )
      rounds += 1
    const fold = messages.slice(at, at + 2 * (rounds - 1))
    // A fold says nothing of where its messages are, so only delivered ones fold.
    if (rounds >= 3 && fold.every((message) => message.state === "delivered")) {
      runs.push({ fold, rounds: rounds - 1 })
      at += fold.length
      continue
    }
    runs.push({ message: messages[at]! })
    at += 1
  }
  return runs
}

const noteOf = (message: AgentMessage, last: boolean): Note | null => {
  switch (message.state) {
    case "queued":
    case "held":
      return "queued"
    case "leased":
      return "leased"
    case "gone":
      return "gone"
    case "delivered":
      return last ? "delivered" : null
  }
}

// The chat of a conversation as `self`'s terminal reads it; `unfolded` shows its repeated
// rounds in full.
export const chatOf = (
  conversation: Conversation,
  self: string,
  unfolded: boolean,
): readonly ChatEntry[] => {
  const you = conversation.key === youKey
  const mine = you ? "you" : self
  const lastMine = conversation.messages.findLast((message) => message.from === mine)
  const entries: ChatEntry[] = []
  let prev: AgentMessage | null = null
  let fresh = false
  const burst = (message: AgentMessage): void => {
    if (prev && message.sentAt - prev.sentAt < burstMs) return
    entries.push({ kind: "time", key: `time-${message.id}`, at: message.sentAt })
    prev = null
  }
  const one = (message: AgentMessage): void => {
    burst(message)
    if (you && !fresh && message.inboxState === "open" && message.from !== "you") {
      entries.push({ kind: "new", key: "new" })
      fresh = true
      prev = null
    }
    entries.push({
      kind: "message",
      key: message.id,
      message,
      side: message.from === mine ? "out" : "in",
      grouped: prev?.from === message.from,
      note: noteOf(message, message === lastMine),
    })
    prev = message
  }
  for (const run of you
    ? conversation.messages.map((message) => ({ message }))
    : foldRounds(conversation.messages)) {
    if ("message" in run) one(run.message)
    else if (unfolded) run.fold.forEach(one)
    else {
      const first = run.fold[0]!
      burst(first)
      entries.push({ kind: "fold", key: `fold-${first.id}`, rounds: run.rounds, first })
      prev = run.fold.at(-1)!
    }
  }
  return entries
}
