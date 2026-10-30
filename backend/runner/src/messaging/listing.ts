import type { MessageThread } from "@novadeck/protocol"

import { addresseeParty, holdOf, senderParty, senderTerminal, stopBlocks } from "./messages.js"
import type { Message, Thread } from "./messages.js"

/** The most threads, and the most messages in a thread, a terminal's listing holds. */
const listedMost = 1000

/** What the listing reads of `Messaging`'s state beside the messages themselves. */
type Standing = {
  readonly thread: (id: string) => Thread | undefined
  /** How many idle messages in a row the thread has (see `Messaging.runs`). */
  readonly idled: (id: string) => number
  readonly holdOf: (message: Message) => ReturnType<typeof holdOf>
  readonly now: number
}

/** When a thread's latest message was sent. */
const latest = (thread: MessageThread): number => thread.messages.at(-1)?.sentAt ?? 0

/** A message's text as the listing shows it: a response with what the person chose before it. */
const listedText = (message: Message): string => {
  if (message.response?.feedback)
    return ["Asked to write feedback about Novadeck.", message.text].filter(Boolean).join("\n\n")
  if (message.response)
    return [message.response.option ?? message.response.action, message.text]
      .filter(Boolean)
      .join("\n\n")
  return message.text
}

/**
 * The threads of `messages`, a terminal's own (oldest first), as the runner API lists
 * them: the most recently active first.
 */
export const listedThreads = (
  terminalId: string,
  messages: readonly Message[],
  standing: Standing,
): MessageThread[] => {
  const byThread = new Map<string, Message[]>()
  for (const message of messages)
    byThread.set(message.thread, [...(byThread.get(message.thread) ?? []), message])
  const threads = [...byThread].map(([id, inThread]): MessageThread => {
    const thread = standing.thread(id)
    const [first] = inThread
    const peer =
      senderTerminal(first!.from) === terminalId
        ? addresseeParty(first!.to)
        : senderParty(first!.from)
    return {
      id,
      peer,
      hops: thread?.hops ?? inThread.length,
      idle: standing.idled(id),
      held: thread?.heldFrom != null,
      heldFor: thread?.heldFor ?? null,
      stopped: thread !== undefined && stopBlocks(thread, standing.now),
      messages: inThread.slice(-listedMost).map((message) => ({
        id: message.id,
        thread: message.thread,
        hop: message.hop,
        from: senderParty(message.from),
        to: addresseeParty(message.to),
        text: listedText(message),
        sentAt: message.sentAt,
        state: message.state,
        held: message.state === "held" ? standing.holdOf(message) : null,
        deliveredAt: message.deliveredAt,
        ...(message.response && !message.response.feedback && { inbox: "answer" as const }),
      })),
    }
  })
  return threads.toSorted((a, b) => latest(b) - latest(a)).slice(0, listedMost)
}
