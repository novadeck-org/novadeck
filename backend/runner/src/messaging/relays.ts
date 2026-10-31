import type { AgentName } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { addressed, awaiting, type Live } from "./live.js"
import type { MessageStore } from "./message-store.js"
import {
  cleanText,
  maxDeliveryBytes,
  maxUndelivered,
  novadeckSender,
  personSender,
  undelivered,
  type Message,
} from "./messages.js"
import { deliveredBytes } from "./sending.js"
import type { Sessions } from "./sessions.js"

/** The exact agent session that an Inbox ask and its answer belong to. */
export type InboxOwner = {
  projectId: string
  workspaceSessionId: string
  terminalId: string
  handle: string
  agent: AgentName
  sessionId: string
}

/** What relays ask of the rest of messaging. */
export type RelaysHost = {
  readonly sessions: Sessions
  readonly store: MessageStore
  readonly now: () => number
}

/**
 * The messages no agent sends that Novadeck relays to an agent: the person's replies to its
 * Inbox asks and requests for feedback, and Novadeck's own automatic notices.
 */
export class Relays {
  constructor(private readonly host: RelaysHost) {}

  /** The exact agent session that an Inbox ask and its answer belong to. */
  inboxOwner(terminalId: string): InboxOwner | undefined {
    const live = this.host.sessions.get(terminalId)
    if (!live?.root || this.host.store.closed) return undefined
    return {
      projectId: live.projectId,
      workspaceSessionId: live.sessionId,
      terminalId,
      handle: live.handle,
      agent: live.root.agent,
      sessionId: live.root.sessionId,
    }
  }

  /** Commits a person's answer before it becomes visible or deliverable. Not an agent operation. */
  personReply(
    terminalId: string,
    askId: string,
    subject: string,
    text: string,
    commit: (message: Message) => void,
    choice?: { readonly option?: string; readonly action?: string },
  ): void {
    const { store } = this.host
    const owner = this.inboxOwner(terminalId)
    if (!owner) throw new DomainError("CONFLICT", "The asking agent's session has ended.")
    const message = {
      id: store.freshMessageId(),
      projectId: owner.projectId,
      thread: `t-${askId.replaceAll("-", "")}`,
      hop: 2,
      from: personSender,
      to: { terminalId, handle: owner.handle, agent: owner.agent, sessionId: owner.sessionId },
      text: cleanText(text),
      sentAt: this.host.now(),
      state: "queued",
      deliveredAt: null,
      notified: true,
      stopped: false,
      fromLead: false,
      toLead: false,
      response: { askId, subject, ...choice },
    } satisfies Message
    const size = deliveredBytes(message)
    if (message.text.length > 4096 || size > maxDeliveryBytes)
      throw new DomainError("ANSWER_FAILED", "That reply is too long. Shorten it and try again.")
    if (
      [...store.messages()].filter(
        (each) =>
          each.response !== undefined && each.to.terminalId === terminalId && undelivered(each),
      ).length >= maxUndelivered
    )
      throw new DomainError(
        "RESOURCE_LIMIT",
        "This agent already has 50 person replies waiting. Try again once they arrive.",
      )
    commit(message)
    store.committed(message)
  }

  /**
   * Queues the person's request that the terminal's agent draft feedback about Novadeck,
   * with their hint (empty for none), as an Inbox answer is: relayed under the person's
   * mark, waking an idle agent and waiting behind a turn in progress. `requestId` names it.
   * NOT_FOUND where no agent session is bound.
   */
  personFeedbackRequest(terminalId: string, requestId: string, hint: string): void {
    const { store } = this.host
    const owner = this.inboxOwner(terminalId)
    if (!owner) throw new DomainError("NOT_FOUND", "No agent session is bound in that terminal.")
    const message: Message = {
      id: store.freshMessageId(),
      projectId: owner.projectId,
      thread: `t-${requestId.replaceAll("-", "")}`,
      hop: 2,
      from: personSender,
      to: { terminalId, handle: owner.handle, agent: owner.agent, sessionId: owner.sessionId },
      text: cleanText(hint),
      sentAt: this.host.now(),
      state: "queued",
      deliveredAt: null,
      notified: true,
      stopped: false,
      fromLead: false,
      toLead: false,
      response: { askId: requestId, subject: "", feedback: true },
    }
    if (message.text.length > 4096 || deliveredBytes(message) > maxDeliveryBytes)
      throw new DomainError("ANSWER_FAILED", "That hint is too long. Shorten it and try again.")
    store.put(message)
  }

  /**
   * Queues an automatic notice from Novadeck itself for the terminal's root session, which
   * its agent gets as any message, waking it when idle (the doorbell). It belongs to no
   * thread, so no loop or hold guards it, and no sender is told of its fate. Where no
   * session is bound yet it is addressed as any message is, to the agent whose prompt
   * shows (or is expected) there, whose first session to bind takes it; false where
   * there is no such agent. It is no peer's conversation: listings leave it out. None is
   * sent while a message that will be delivered to that agent soon already waits, queued
   * or leased and addressed to it (`soon`), whose delivery wakes it as well and stands in
   * for it, which also keeps at most one notice waiting. A message held for the person's
   * release, or for another session, does not. With `always`, for a notice that carries
   * news the agent has no other way to learn (an outcome), it is queued all the same,
   * and wakes the agent as the waiting message does.
   */
  notice(terminalId: string, text: string, { always = false } = {}): boolean {
    const { store } = this.host
    const live = this.host.sessions.get(terminalId)
    if (!live || store.closed) return false
    const agent = live.root?.agent ?? live.shown?.agent ?? live.expecting
    if (!agent) return false
    if (!always) for (const message of store.messages()) if (this.soon(live, message)) return false
    const id = store.freshMessageId()
    store.put({
      id,
      projectId: live.projectId,
      thread: `t-notice-${id}`,
      hop: 1,
      from: novadeckSender,
      to: {
        terminalId,
        handle: live.handle,
        agent,
        sessionId: live.root?.sessionId ?? null,
      },
      text: cleanText(text),
      sentAt: this.host.now(),
      state: store.isPaused() ? "held" : "queued",
      deliveredAt: null,
      notified: true,
      stopped: false,
      fromLead: false,
      toLead: false,
    })
    return true
  }

  /**
   * Queues Novadeck's message telling the terminal's agent of a grant made or ended: it
   * carries only the grant's id, and `wrap` renders `<grant>` or `<grant-ended>` from the
   * grant itself when it is delivered. Like a notice it wakes an idle agent, belongs to no
   * thread and needs no reply. False where no agent is there to tell.
   */
  grantNotice(terminalId: string, grantId: string): boolean {
    const { store } = this.host
    const live = this.host.sessions.get(terminalId)
    if (!live || store.closed) return false
    const agent = live.root?.agent ?? live.shown?.agent ?? live.expecting
    if (!agent) return false
    const id = store.freshMessageId()
    store.put({
      id,
      projectId: live.projectId,
      thread: `t-notice-${id}`,
      hop: 1,
      from: novadeckSender,
      to: { terminalId, handle: live.handle, agent, sessionId: live.root?.sessionId ?? null },
      text: `Novadeck: the user's grant ${grantId} changed.`,
      sentAt: this.host.now(),
      state: store.isPaused() ? "held" : "queued",
      deliveredAt: null,
      notified: true,
      stopped: false,
      fromLead: false,
      toLead: false,
      grantId,
    })
    return true
  }

  /**
   * Whether a message will be delivered to the agent at the terminal soon: queued or leased,
   * addressed to its root session or, where none is bound, to the agent about to bind. Not
   * one held for the person's release, gone, or for another session; one held only while
   * messaging is paused arrives once it is resumed.
   */
  private soon(live: Live, message: Message): boolean {
    if (message.to.terminalId !== live.terminalId) return false
    if (!undelivered(message) || this.host.store.holdOf(message) === "release") return false
    if (live.root) return addressed(message, live.root)
    if (awaiting(live, message)) return true
    return (
      message.to.sessionId === null && message.to.agent === (live.shown?.agent ?? live.expecting)
    )
  }
}
