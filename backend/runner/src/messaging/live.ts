import type { HarnessEvent } from "@novadeck/harness-core/events"
import type { AgentName } from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import { rootedIn, type Root } from "../harnesses/roots.js"
import { mention } from "../terminals/handles.js"
import { unbound, type Delivery, type Waits } from "./delivery.js"
import type { Loops } from "./loops.js"
import type { Held, Message } from "./messages.js"
import { untrustedNote } from "./peers.js"

/** Which terminals see each other: those of one project and one Novadeck session. */
export type Scope = { readonly projectId: string; readonly sessionId: string }

/**
 * A running terminal, as messaging knows it: one mutable record per terminal, which
 * `Sessions` keeps and every part of messaging is handed by identity.
 */
export type Live = Scope & {
  readonly terminalId: string
  readonly handle: string
  /**
   * The handle of the terminal whose agent leads this one: it opened this terminal with a
   * brief, and directs its work. It belongs to the terminal, not to a session, so it
   * outlasts a `/clear` or a restart of either agent, and ends when this terminal's agent
   * exits (`endLead`). It means anything only while a running terminal in the same
   * project and session has that handle (handles are never reused there): its running lead.
   */
  ledBy: string | null
  /** Its root session, as the terminal manager follows it. */
  root: Root | null
  delivery: Delivery
  /**
   * The agent expected to bind there, which messages may be addressed to before it has;
   * none once a root session has, when only a bound session takes messages.
   */
  expecting: AgentName | null
  /**
   * The agent whose own prompt shows there before any session of its has bound, with the
   * start of the session's id where the harness showed that much: messages wait for the
   * first session of that agent to bind, or for that session. None once one binds.
   */
  shown: { readonly agent: AgentName; readonly prefix: string | null } | null
  /**
   * The agent whose own prompt showed there with no session bound, but whose hooks
   * Novadeck found untrusted there (Codex's `/hooks`): nothing can deliver to it, so
   * `send` refuses. None once its prompt counts, a session binds, or it leaves.
   */
  untrusted: AgentName | null
  /** The Escape `escaped` last told the agent's activity of, so it tells each one once. */
  escapeTold: number | null
  /** Whether a Stop it would have continued lapsed, its turn ended there, yet untold. */
  lapsed: boolean
  /** The prompt that started the current root turn, by its delivery epoch; null before any. */
  prompt: { readonly epoch: number; readonly text: string } | null
  /**
   * The person's prompt whose asks are yet to be withdrawn with their notice: when they
   * submitted it, and the delivery epoch of the turn it started, which alone may pay it.
   */
  withdrawing: { readonly submittedAt: number; readonly epoch: number } | null
  /**
   * The fixed lines Inbox buttons sent, as the prompt reads once sent (see `sentText`), each
   * until the turn of the person's that carries it spends it, or its send fails. One entry
   * for each send, oldest first.
   */
  automatic: string[]
  /** When the person's last key came; the doorbell's screen look before it is stale. */
  keyedAt: number
  /** Why the doorbell last found the idle agent unringable, from its screen; null if not. */
  waits: Waits | null
  /**
   * Since when its agent has been idle without a break (Settled, Ready, Fresh, Drafting or
   * Unknown), what the doorbell rings or looks at; null while it isn't.
   */
  idleSince: number | null
  /**
   * The nonces of its latest rings that no doorbell prompt confirmed, oldest first: a line
   * of one left alone in its box is Novadeck's to submit. A confirmed one's line in the box
   * is the person's: put back by their Escape, or recalled from the prompt's history.
   */
  unconfirmed: readonly string[]
  /** Whether it is Ready because its screen showed the box empty, not a session's start. */
  viaScreen: boolean
  /**
   * The rules notes its root session holds in its context, given in full by an earlier
   * delivery: a later one only points to them. None for a new root, until the terminal
   * manager tells what that session was told before (`Messaging.held`).
   */
  held: Held
}

/** A terminal as it starts, or starts again: no session bound, nothing expected yet. */
export const started = (
  terminalId: string,
  scope: Scope,
  handle: string,
  ledBy: string | null,
): Live => ({
  terminalId,
  ...scope,
  handle,
  ledBy,
  root: null,
  delivery: unbound,
  expecting: null,
  shown: null,
  untrusted: null,
  escapeTold: null,
  lapsed: false,
  prompt: null,
  automatic: [],
  withdrawing: null,
  keyedAt: 0,
  waits: null,
  idleSince: null,
  unconfirmed: [],
  viaScreen: false,
  held: {},
})

/**
 * Whether the terminal's bound agent takes a prompt while only work its stopped turn left
 * running runs (`MessagingProfile.promptsInBackground`): the doorbell may ring it then.
 */
export const promptsInBackground = (live: Live): boolean =>
  live.root !== null && harnesses[live.root.agent].messaging.promptsInBackground === true

/** The events that mark a turn's course, which the tracker takes only of the root session. */
const turnMarks: ReadonlySet<string> = new Set([
  "turn-started",
  "turn-ended",
  "turn-continued",
  "turn-escaped",
  "turn-lapsed",
  "turn-idle",
  "turn-working",
])

/**
 * Tells the work tracker what a terminal's session reported. The turn's own marks count
 * only from the root session: Antigravity also reports turns of its subagents'
 * conversations, which are not the root's.
 */
export const feed = (
  loops: Loops,
  now: () => number,
  live: Live,
  events: readonly HarnessEvent[],
): void => {
  const root = events.filter((event) => !turnMarks.has(event.type) || rootedIn(live.root, event))
  if (root.length > 0) loops.observe(live.terminalId, root, now())
}

/** Whether a message is for the root session. */
export const addressed = (message: Pick<Message, "to">, root: Root): boolean =>
  message.to.agent === root.agent && message.to.sessionId === root.sessionId

/**
 * Whether a message waits for the session to come where the agent's prompt shows, with
 * no session bound: the first of that agent, or the one whose id starts as it showed.
 */
export const awaiting = (live: Live, message: Pick<Message, "to">): boolean => {
  const { shown } = live
  if (!shown || message.to.agent !== shown.agent) return false
  const { sessionId } = message.to
  return sessionId === null || (shown.prefix !== null && sessionId.startsWith(shown.prefix))
}

/** Whether the terminal's own session never bound, so replies can't reach it. */
export const neverBound = (live: Live): boolean => live.root === null && !live.shown

/** Whether `lead` is the running lead of `worker`. */
export const leads = (worker: Live, lead: Live): boolean =>
  worker.ledBy !== null &&
  worker.ledBy === lead.handle &&
  worker.projectId === lead.projectId &&
  worker.sessionId === lead.sessionId

/** The agent messages to a terminal reach, as `send` judges a recipient; or why none does. */
export type Deliverable =
  | { readonly ok: true; readonly agent: AgentName; readonly sessionId: string | null }
  | { readonly ok: false; readonly reason: string; readonly code: "untrusted" | "none" }

/**
 * The agent Novadeck can deliver messages to in a terminal, with its root session's id
 * once one is bound; or why there is none, as `send` refuses a recipient.
 */
export const deliverableAgent = (recipient: Live): Deliverable => {
  const { root } = recipient
  if (!root && !recipient.shown && recipient.untrusted)
    return {
      ok: false,
      code: "untrusted",
      reason:
        `${mention(recipient.handle)} has no agent Novadeck can deliver to: ` +
        `${untrustedNote(recipient.untrusted)}.`,
    }
  const agent = root?.agent ?? recipient.shown?.agent ?? recipient.expecting
  if (!agent)
    return {
      ok: false,
      code: "none",
      reason: `${mention(recipient.handle)} has no agent running there that Novadeck can deliver to.`,
    }
  return { ok: true, agent, sessionId: root?.sessionId ?? null }
}
