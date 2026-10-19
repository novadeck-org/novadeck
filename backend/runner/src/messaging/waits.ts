import { undelivered, type Message } from "./mailbox.js"

/** The messages waiting for one terminal: how many, and the oldest of them. */
export type Wait = {
  readonly terminalId: string
  readonly count: number
  readonly oldestId: string
  readonly oldestAt: number
}

/**
 * Each terminal's waiting messages whose oldest was sent at least `longerThanMs` before
 * `now`, whatever keeps them waiting: a working agent, a held thread, a box with text.
 */
export const longWaits = (messages: Iterable<Message>, now: number, longerThanMs = 0): Wait[] => {
  const found = new Map<string, Wait>()
  for (const message of messages) {
    if (!undelivered(message)) continue
    const terminalId = message.to.terminalId
    const known = found.get(terminalId)
    const oldest = !known || message.sentAt < known.oldestAt
    found.set(terminalId, {
      terminalId,
      count: (known?.count ?? 0) + 1,
      oldestId: oldest ? message.id : known.oldestId,
      oldestAt: oldest ? message.sentAt : known.oldestAt,
    })
  }
  return [...found.values()].filter((wait) => now - wait.oldestAt >= longerThanMs)
}
