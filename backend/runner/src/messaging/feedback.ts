import { randomUUID } from "node:crypto"

import {
  feedbackKind,
  maxFeedbackText,
  type AgentName,
  type FeedbackDraft,
} from "@novadeck/protocol"
import { redact } from "@novadeck/secrets"
import { Latest } from "@novadeck/wire/server"
import { z } from "zod"

import { DomainError } from "../errors.js"
import {
  allowSend,
  cleanInboxText,
  rates,
  recentSends,
  undelivered,
  type Message,
} from "./messages.js"

/** The agent session a terminal's draft is written by. */
type Owner = {
  readonly projectId: string
  readonly workspaceSessionId: string
  readonly terminalId: string
  readonly handle: string
  readonly agent: AgentName
  readonly sessionId: string
}
type Host = {
  owner(terminalId: string): Owner | undefined
  exists(terminalId: string): boolean
  replyState(requestId: string): Message | undefined
  /** Relays the person's request to the terminal's agent (see `ask`). */
  request(terminalId: string, requestId: string, hint: string): void
}

const draftRequest = z.strictObject({
  kind: feedbackKind,
  // A draft is the agent's own words and may quote a terminal: what looks like a secret is masked.
  text: z
    .string()
    .transform((text) => redact(cleanInboxText(text)))
    .pipe(z.string().trim().min(1).max(maxFeedbackText)),
})

/**
 * The feedback agents draft about Novadeck with their `feedback` tool, for the app to show
 * in its feedback card. Held in memory only: one draft per terminal, which outlives its
 * agent session and its terminal until the app settles it, its project is removed or the
 * runner restarts, which forgets it. The runner never sends one.
 */
export class Feedback {
  private readonly drafts = new Map<string, FeedbackDraft>()
  /** The person's request for a draft, per terminal, with the agent session it is for. */
  private readonly asks = new Map<
    string,
    {
      readonly projectId: string
      readonly agent: string
      readonly sessionId: string
      readonly requestId: string
    }
  >()
  /** When each terminal's recent drafts were made, for the draft rate limit, with its project. */
  private readonly sent = new Map<
    string,
    { readonly projectId: string; readonly times: readonly number[] }
  >()
  private readonly readers = new Set<Latest<FeedbackDraft[]>>()
  private closed = false
  constructor(
    private readonly host: Host,
    private readonly now = Date.now,
  ) {}

  /** An agent's `feedback` call: its draft replaces the terminal's earlier one. */
  call(
    terminalId: string,
    request: unknown,
  ): { ok: true; id: string } | { ok: false; reason: string } {
    if (this.closed) return { ok: false, reason: "Novadeck is stopping." }
    const owner = this.host.owner(terminalId)
    if (!owner)
      return {
        ok: false,
        reason:
          "Your agent session has not bound in this terminal yet, so a draft could not be kept.",
      }
    const parsed = draftRequest.safeParse(request)
    if (!parsed.success)
      return { ok: false, reason: parsed.error.issues[0]?.message ?? "That draft doesn't fit." }
    const at = this.now()
    this.prune(at)
    const times = allowSend(this.sent.get(terminalId)?.times ?? [], at, rates.sender)
    if (!times)
      return {
        ok: false,
        reason: `An agent may draft ${rates.sender} pieces of feedback a minute. Try again shortly.`,
      }
    this.sent.set(terminalId, { projectId: owner.projectId, times })
    const asked = this.requested(terminalId, owner) === "delivered"
    if (asked) this.asks.delete(terminalId)
    const draft: FeedbackDraft = {
      id: randomUUID(),
      terminalId,
      projectId: owner.projectId,
      workspaceSessionId: owner.workspaceSessionId,
      agent: owner.agent,
      handle: owner.handle,
      at,
      ...parsed.data,
      asked,
    }
    this.drafts.set(terminalId, draft)
    this.publish()
    return { ok: true, id: draft.id }
  }

  /**
   * The person asks the agent in a terminal for a draft, with their hint: relayed to it as
   * an Inbox answer is. The draft that follows, once the request reached the agent, is
   * `asked`. An unknown terminal is TERMINAL_NOT_FOUND, one with no agent session bound
   * NOT_FOUND, one whose earlier request still waits CONFLICT.
   */
  ask(terminalId: string, hint: string): void {
    if (this.closed) throw new DomainError("CLOSING")
    if (!this.host.exists(terminalId)) throw new DomainError("TERMINAL_NOT_FOUND")
    const owner = this.host.owner(terminalId)
    if (!owner) throw new DomainError("NOT_FOUND", "No agent session is bound in that terminal.")
    if (this.requested(terminalId, owner) === "waiting")
      throw new DomainError(
        "CONFLICT",
        "A request for feedback is already waiting to reach that agent.",
      )
    const requestId = randomUUID()
    this.host.request(terminalId, requestId, cleanInboxText(hint).trim())
    this.asks.set(terminalId, {
      projectId: owner.projectId,
      agent: owner.agent,
      sessionId: owner.sessionId,
      requestId,
    })
  }

  /** Drops a draft the app sent or the person discarded; its agent isn't told. Else NOT_FOUND. */
  settle(id: string): void {
    if (this.closed) throw new DomainError("CLOSING")
    const draft = [...this.drafts.values()].find((each) => each.id === id)
    if (!draft) throw new DomainError("NOT_FOUND", "This feedback draft is not waiting.")
    this.drafts.delete(draft.terminalId)
    this.publish()
  }

  /** The drafts waiting, oldest first. */
  list(): FeedbackDraft[] {
    return [...this.drafts.values()].toSorted((a, b) => a.at - b.at)
  }

  async *watch(signal?: AbortSignal): AsyncGenerator<FeedbackDraft[]> {
    const reader = new Latest<FeedbackDraft[]>()
    this.readers.add(reader)
    reader.push(this.list())
    const abort = () => reader.finish()
    signal?.addEventListener("abort", abort, { once: true })
    if (this.closed || signal?.aborted) reader.finish()
    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Listings are delivered in order.
        const next = await reader.next()
        if (next === undefined) return
        yield next
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      reader.finish()
      this.readers.delete(reader)
    }
  }

  /** A removed project's drafts go with it. */
  forgetProject(projectId: string): void {
    for (const [terminalId, draft] of this.drafts)
      if (draft.projectId === projectId) this.drafts.delete(terminalId)
    for (const [terminalId, ask] of this.asks)
      if (ask.projectId === projectId) this.asks.delete(terminalId)
    for (const [terminalId, each] of this.sent)
      if (each.projectId === projectId) this.sent.delete(terminalId)
    this.publish()
  }

  close(): void {
    this.closed = true
    for (const reader of this.readers) reader.finish()
    this.readers.clear()
  }

  /**
   * Where the person's request stands for the session `owner`: waiting for its delivery, or
   * delivered. One that went gone, or was for another session, is forgotten, and none stands.
   */
  private requested(terminalId: string, owner: Owner): "waiting" | "delivered" | undefined {
    const asking = this.asks.get(terminalId)
    if (!asking) return undefined
    const reply = this.host.replyState(asking.requestId)
    if (
      !reply ||
      reply.state === "gone" ||
      asking.agent !== owner.agent ||
      asking.sessionId !== owner.sessionId
    ) {
      this.asks.delete(terminalId)
      return undefined
    }
    return undelivered(reply) ? "waiting" : "delivered"
  }

  /** Forgets the rate record of drafts older than the window, and what a closed terminal left. */
  private prune(at: number): void {
    for (const [terminalId, each] of this.sent) {
      const recent = recentSends(each.times, at)
      if (recent.length > 0 && this.host.exists(terminalId))
        this.sent.set(terminalId, { ...each, times: recent })
      else this.sent.delete(terminalId)
    }
    for (const terminalId of this.asks.keys())
      if (!this.host.exists(terminalId)) this.asks.delete(terminalId)
  }

  private publish(): void {
    if (!this.readers.size) return
    const listing = this.list()
    const key = JSON.stringify(listing)
    for (const reader of this.readers) reader.push(listing, key)
  }
}
