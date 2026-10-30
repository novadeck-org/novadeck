import { leads } from "./live.js"
import type { MessageStore } from "./message-store.js"
import type { SendAnswer } from "./sending.js"
import type { Sessions } from "./sessions.js"

/** What leads ask of the rest of messaging. */
export type LeadingHost = {
  readonly sessions: Sessions
  readonly store: MessageStore
  /** An agent's message to another terminal (`Messaging.send`). */
  readonly send: (terminalId: string, request: unknown) => SendAnswer
}

/**
 * Leads: which running terminal leads each one, the brief whose delivery ends a lead that
 * lasts only until then, and what becomes of a lead's messages once it ends or the person
 * releases the terminal from it.
 */
export class Leading {
  /**
   * The brief of each terminal whose lead lasts only until it is delivered, by terminal:
   * the message that is the one lead-marked message there. In memory only, and gone when
   * the lead ends or is set again.
   */
  private readonly briefs = new Map<string, string>()
  /** Whether the message being sent is such a brief (see `sendBrief`). */
  private briefing = false
  // Messages gone because the person released their recipient from the lead that sent them.
  // (Dropped with the message when it is pruned, or once its sender is told.)
  private readonly releasedMessages = new Set<string>()

  constructor(private readonly host: LeadingHost) {}

  /**
   * Whether a message its running lead sends the terminal now carries the lead mark: not
   * while a brief that is the one marked message there waits, unless it is that brief.
   */
  marks(terminalId: string): boolean {
    return this.briefing || !this.briefs.has(terminalId)
  }

  /** Lets go of the brief the terminal's lead waits on, as it closes; whether there was one. */
  letBriefGo(terminalId: string): boolean {
    return this.briefs.delete(terminalId)
  }

  /** Whether the message went because the person released its recipient from the lead. */
  released(messageId: string): boolean {
    return this.releasedMessages.has(messageId)
  }

  /** The message was forgotten, or its sender told it went: its release is done with. */
  forgot(messageId: string): void {
    this.releasedMessages.delete(messageId)
  }

  /**
   * The terminal's lead ends, as its agent exits: messages sent after are a peer's. Its
   * lead's brief still waiting for the terminal's first session (queued or held, bound to
   * none) is gone, and its sender told, as no session it was for will bind; what already
   * belongs to a session stays, with the authority it had when sent.
   */
  endLead(terminalId: string): void {
    const { store } = this.host
    this.briefs.delete(terminalId)
    const live = this.host.sessions.get(terminalId)
    if (!live) return
    live.ledBy = null
    for (const message of store.messages())
      if (
        message.to.terminalId === terminalId &&
        message.to.sessionId === null &&
        message.fromLead &&
        (message.state === "queued" || message.state === "held")
      )
        store.gone(message, "lead-ended")
  }

  /**
   * The terminal gains a lead, as the person let an agent lead it: messages that lead sends
   * after carry the lead mark. The terminal's `ledBy`, as `register` sets it for one opened
   * with a brief.
   */
  setLead(terminalId: string, handle: string): void {
    const live = this.host.sessions.get(terminalId)
    if (live) live.ledBy = handle
    this.briefs.delete(terminalId)
  }

  /**
   * Sends the brief of a lead that lasts only until it is delivered, the one message of that
   * lead marked so: the lead's other messages to the terminal while it waits go as a peer's.
   * Answered as `send` is.
   */
  sendBrief(terminalId: string, request: unknown): SendAnswer {
    this.briefing = true
    try {
      const answer = this.host.send(terminalId, request)
      const message = answer.ok ? this.host.store.message(answer.id) : undefined
      if (message?.fromLead) this.briefs.set(message.to.terminalId, message.id)
      return answer
    } finally {
      this.briefing = false
    }
  }

  /** The brief whose delivery ends the terminal's lead, if it waits for one. */
  briefOf(terminalId: string): string | undefined {
    return this.briefs.get(terminalId)
  }

  /**
   * The person releases the terminal from its lead: the lead's messages to it that were not
   * delivered yet, queued or held, whatever session they wait for, are gone, and their
   * sender is told they went because the person released it. One a lease holds is marked, so
   * that it is dropped the same way should its lease lapse.
   */
  dropLeadMessages(terminalId: string): void {
    const { store } = this.host
    for (const message of store.messages())
      if (
        message.to.terminalId === terminalId &&
        message.fromLead &&
        (message.state === "queued" || message.state === "held" || message.state === "leased")
      ) {
        this.releasedMessages.add(message.id)
        // Kept as the person's stop of a thread is: `stopped` is saved, so no session that
        // binds again, and no restart, brings it back. A leased one is left to finish; if
        // its lease lapses, or the runner restarts, it is gone then (`wait`).
        if (message.state === "leased") store.put({ ...message, stopped: true })
        else {
          store.noteGone(message, "lead-released")
          store.put({ ...message, state: "gone", notified: false, stopped: true })
        }
      }
  }

  /**
   * The handle of the running terminal that leads the terminal, if there is one: the one
   * its `ledBy` names, still running in its project and session.
   */
  leadOf(terminalId: string): string | undefined {
    const { sessions } = this.host
    const live = sessions.get(terminalId)
    return live && sessions.scoped(live).find((peer) => leads(live, peer))?.handle
  }
}
