import { logs } from "../log.js"
import type { MessageStore } from "./message-store.js"
import { isNotice, undelivered, type Message } from "./messages.js"
import type { Sessions } from "./sessions.js"

const log = logs.for("messaging")

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

/** How long messages wait for a terminal before the log says so, whatever keeps them. */
const longWaitMs = 5 * 60_000

/** How often a wait that goes on is told again. */
const longWaitAgainMs = 60 * 60_000

/** What the log of long waits reads of the rest of messaging. */
export type LongWaitsHost = {
  readonly sessions: Sessions
  readonly store: MessageStore
  readonly now: () => number
}

/** The log of messages that wait long for their terminal, and how long each terminal's have. */
export class LongWaits {
  /** Each long wait told, by terminal: its oldest message and when it was told. */
  private readonly told = new Map<string, { readonly id: string; readonly at: number }>()

  constructor(private readonly host: LongWaitsHost) {}

  /**
   * Logs each terminal whose messages have waited longer than `longWaitMs`, whatever keeps
   * them (a working agent, a held thread, text in its box), with its delivery state; once,
   * and again every `longWaitAgainMs` while the same message still waits.
   */
  tell(): void {
    const now = this.host.now()
    const long = longWaits(this.host.store.messages(), now, longWaitMs)
    for (const wait of long) {
      const told = this.told.get(wait.terminalId)
      if (told?.id === wait.oldestId && now - told.at < longWaitAgainMs) continue
      this.told.set(wait.terminalId, { id: wait.oldestId, at: now })
      const live = this.host.sessions.get(wait.terminalId)
      log.info("delivery.waiting", "Messages have waited long for a terminal.", {
        data: {
          terminal: wait.terminalId,
          count: wait.count,
          waitedMs: now - wait.oldestAt,
          state: live?.delivery.state ?? null,
          waits: live?.waits ?? null,
        },
      })
    }
    const still = new Set(long.map((wait) => wait.terminalId))
    for (const terminalId of this.told.keys())
      if (!still.has(terminalId)) this.told.delete(terminalId)
  }

  /** How long the oldest message waiting for the terminal has waited, in milliseconds; null for none. */
  waitedMs(terminalId: string): number | null {
    const [wait] = longWaits(
      [...this.host.store.messages()].filter(
        (message) => message.to.terminalId === terminalId && !isNotice(message),
      ),
      this.host.now(),
    )
    return wait ? this.host.now() - wait.oldestAt : null
  }
}
