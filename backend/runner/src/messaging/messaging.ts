import type { ActivityEvent, HarnessEvent } from "@novadeck/harness-core/events"
import { hookShellSlackMs } from "@novadeck/harness-core/hook-command"
import type { AgentName, MessageState, TerminalMessages } from "@novadeck/protocol"
import type { KeyKind } from "@novadeck/tui-input"

import type { Binding } from "../harnesses/bindings.js"
import type { RootChange } from "../harnesses/roots.js"
import { Deliveries } from "./deliveries.js"
import type { Delivery, Waits } from "./delivery.js"
import { grantsOf, type GrantOptions, type Grants, type SavedScope } from "./grants.js"
import { Holds } from "./holds.js"
import { HookAnswers, type Answer } from "./hook-answers.js"
import { Leading } from "./leading.js"
import { Leasing, type LeasingHost } from "./leasing.js"
import type { Deliverable, Scope } from "./live.js"
import { Loops } from "./loops.js"
import { MessageStore, type MessagingChange } from "./message-store.js"
import type { Held, Message } from "./messages.js"
import type { About } from "./peers.js"
import { memoryMessages, type MessageRecords } from "./records.js"
import { Relays, type InboxOwner } from "./relays.js"
import {
  Sending,
  type AgentsAnswer,
  type PeerAnswer,
  type SendAnswer,
  type OnTheWay,
  type TeamAnswer,
} from "./sending.js"
import { Sessions } from "./sessions.js"
import { startTimers } from "./timers.js"
import { LongWaits } from "./waits.js"
import { Withdrawals, type Person } from "./withdrawals.js"

export type MessagingOptions = {
  /** Where messages, threads and the pause are kept; in memory when omitted. */
  readonly records?: MessageRecords
  readonly now?: () => number
  /** How long a lease waits for its hook's acknowledgement, in milliseconds. */
  readonly leaseMs?: number
  /** How often messages past retention are deleted, in milliseconds. */
  readonly sweepMs?: number
  /** How often long waits are looked for, for the log, in milliseconds; 0 for never. */
  readonly waitsMs?: number
  /**
   * How long after the runner starts its terminals have to be restored and their agents
   * resumed, in milliseconds: then messages for a session not running are gone, until it
   * runs again.
   */
  readonly restoreMs?: number
  /** Whether a terminal exists, running or kept; one running counts when omitted. */
  readonly exists?: (terminalId: string) => boolean
  /**
   * Whether the agent's activity says a turn or subagents run there, as the doorbell judges
   * it: no hold counts while one does, though delivery may take the agent for idle (Unknown
   * after an Escape that only closed a popup). Never, when omitted.
   */
  readonly busy?: (terminalId: string) => boolean
  /**
   * The platform the harnesses' hooks run on, whose shells may hold a hook back (see
   * `hookShellSlackMs`); the runner's own when omitted.
   */
  readonly platform?: NodeJS.Platform
  /** What each terminal's agent did, for the loop hold; a new tracker when omitted. */
  readonly loops?: Loops
  /** The notes a root session holds grew, for the terminals to keep (`LeasingHost.held`). */
  readonly held?: LeasingHost["held"]
} & GrantOptions

/**
 * Messages between the agents in Novadeck's terminals (see docs/agent-messaging.md). The
 * terminal manager owns the terminals, their handles, roots and work, tells it what their
 * agents and people do, and asks it what each hook prints. This class is the hub that
 * builds the parts and answers for them:
 *
 * - `MessageStore` (`message-store.ts`): every message and thread, and the pause;
 * - `Sessions` (`sessions.ts`): the running terminals and their root sessions;
 * - `Deliveries` (`deliveries.ts`): each terminal's delivery state, and the doorbell's view;
 * - `HookAnswers` (`hook-answers.ts`): what each hook prints;
 * - `Leasing` (`leasing.ts`): the leases of what hooks print, and their confirmation;
 * - `Withdrawals` (`withdrawals.ts`): the asks the person's own prompts take out;
 * - `Holds` (`holds.ts`): threads held for release, and messages held long;
 * - `Leading` (`leading.ts`): leads, their briefs, and the person's release;
 * - `Sending` (`sending.ts`): agents' messages, the peers listing, and the runner's listing;
 * - `Relays` (`relays.ts`): the person's replies and Novadeck's notices;
 * - `LongWaits` (`waits.ts`): the log of messages that wait long.
 *
 * Its parts reach each other through narrow hosts; this class's methods only hand on.
 */
export class Messaging {
  private readonly store: MessageStore
  private readonly sessions: Sessions
  private readonly deliveries: Deliveries
  private readonly leasing: Leasing
  private readonly withdrawals: Withdrawals
  private readonly hookAnswers: HookAnswers
  private readonly holds: Holds
  private readonly leading: Leading
  private readonly sending: Sending
  private readonly relays: Relays
  readonly grants: Grants
  private readonly waits: LongWaits
  private readonly stopTimers: () => void

  constructor(options: MessagingOptions = {}) {
    const now = options.now ?? Date.now
    const loops = options.loops ?? new Loops(now)
    const step: Deliveries["step"] = (live, event) => this.deliveries.step(live, event)
    // Built first, it reads the records; what it forgets, the other parts forget too.
    const store = new MessageStore(options.records ?? memoryMessages(), now, {
      exists: options.exists ?? ((terminalId) => this.sessions.has(terminalId)),
      forgot: (messageId) => {
        this.leading.forgot(messageId)
        this.holds.forgot(messageId)
      },
      forgotThread: (threadId) => this.holds.forgotThread(threadId),
    })
    this.store = store
    const sessions = new Sessions({
      store,
      loops,
      now,
      step,
      letBriefGo: (terminalId) => this.leading.letBriefGo(terminalId),
    })
    this.sessions = sessions
    this.relays = new Relays({ sessions, store, now })
    this.grants = grantsOf({ sessions, now, relays: this.relays }, options)
    const leasing = { sessions, store, loops, now, step, held: options.held, grants: this.grants }
    this.leasing = new Leasing(options.leaseMs ?? 5_000, leasing, options.platform)
    this.deliveries = new Deliveries({
      sessions,
      store,
      loops,
      now,
      slackMs: hookShellSlackMs(options.platform ?? process.platform),
      leftBehind: (terminalId) => this.leasing.forget(terminalId),
    })
    this.withdrawals = new Withdrawals({ sessions, closed: () => store.closed })
    this.holds = new Holds({ sessions, store, loops, now, busy: options.busy ?? (() => false) })
    this.leading = new Leading({
      sessions,
      store,
      send: (terminalId, request) => this.send(terminalId, request),
    })
    this.sending = new Sending({
      sessions,
      store,
      loops,
      now,
      holds: this.holds,
      leading: this.leading,
    })
    this.hookAnswers = new HookAnswers({
      sessions,
      store,
      loops,
      now,
      deliveries: this.deliveries,
      leasing: this.leasing,
      withdrawals: this.withdrawals,
      heldFrom: (terminalId) => this.heldFrom(terminalId),
    })
    this.waits = new LongWaits({ sessions, store, now })
    this.stopTimers = startTimers(options, {
      sweep: () => this.sweep(),
      restored: () => sessions.restored(),
      waits: () => this.tellWaits(),
    })
  }

  /**
   * Stops its timers and changes no message from then on, nor leases one: leases left, and
   * every message waiting, wait again with the next runner, for their sessions resumed there.
   */
  close(): void {
    this.store.close()
    this.grants.close()
    this.stopTimers()
    this.leasing.clear()
  }

  // The message store: see `MessageStore`.

  subscribe(listener: (change: MessagingChange) => void): () => void {
    return this.store.subscribe(listener)
  }

  isPaused(): boolean {
    return this.store.isPaused()
  }

  pause(paused: boolean): void {
    this.store.pause(paused)
  }

  /** Where the message is now; undefined once it is forgotten. */
  stateOf(messageId: string): MessageState | undefined {
    return this.store.message(messageId)?.state
  }

  /** Whether the message was sent by its recipient's running lead, so it is marked so. */
  isFromLead(messageId: string): boolean {
    return this.store.message(messageId)?.fromLead === true
  }

  inboxReply(askId: string): Message | undefined {
    return this.store.inboxReply(askId)
  }

  forgetResponses(ids: readonly string[]): void {
    this.store.forgetResponses(ids)
  }

  forgetProject(projectId: string): void {
    this.store.forgetProject(projectId)
  }

  sweep(): void {
    this.store.sweep()
  }

  // The running terminals and their root sessions: see `Sessions`.

  register(terminalId: string, scope: Scope, handle: string, ledBy: string | null): void {
    this.sessions.register(terminalId, scope, handle, ledBy)
  }

  unregister(terminalId: string, forGood = false, saved?: SavedScope): void {
    this.grants.unregister(terminalId, forGood, saved)
  }

  rooted(terminalId: string, changes: readonly RootChange[], held?: Held): void {
    this.sessions.rooted(terminalId, changes, held)
  }

  awaits(terminalId: string, sessionId: string): boolean {
    return this.sessions.awaits(terminalId, sessionId)
  }

  // Each terminal's delivery state: see `Deliveries`.

  delivery(terminalId: string): Delivery | undefined {
    return this.deliveries.delivery(terminalId)
  }

  expect(terminalId: string, agent: AgentName | null): void {
    this.deliveries.expect(terminalId, agent)
  }

  shown(
    terminalId: string,
    agent: AgentName,
    prefix: string | null,
    replaces?: boolean,
    at?: number,
    firedAt?: number,
  ): void {
    this.deliveries.shown(terminalId, agent, prefix, replaces, at, firedAt)
  }

  escaped(terminalId: string, binding: Binding): ActivityEvent | undefined {
    return this.deliveries.escaped(terminalId, binding)
  }

  untrustedAgent(terminalId: string): AgentName | undefined {
    return this.deliveries.untrustedAgent(terminalId)
  }

  shownAgent(terminalId: string): AgentName | undefined {
    return this.deliveries.shownAgent(terminalId)
  }

  untrusted(terminalId: string, agent: AgentName): void {
    this.deliveries.untrusted(terminalId, agent)
  }

  unshown(terminalId: string): void {
    this.deliveries.unshown(terminalId)
  }

  keys(terminalId: string, kinds: readonly KeyKind[], asked: boolean): void {
    this.deliveries.keys(terminalId, kinds, asked)
  }

  pressing(terminalId: string, press: () => void): void {
    this.deliveries.pressing(terminalId, press)
  }

  emptied(terminalId: string, epoch: number, readAt?: number): void {
    this.deliveries.emptied(terminalId, epoch, readAt)
  }

  stalled(terminalId: string): boolean {
    return this.deliveries.stalled(terminalId)
  }

  queueBar(terminalId: string): number {
    return this.deliveries.queueBar(terminalId)
  }

  blocked(terminalId: string, waits: Waits | null): void {
    this.deliveries.blocked(terminalId, waits)
  }

  askedCleared(terminalId: string): void {
    this.deliveries.askedCleared(terminalId)
  }

  ringable(terminalId: string): boolean {
    return this.deliveries.ringable(terminalId)
  }

  personPrompt(terminalId: string): string | undefined {
    return this.deliveries.personPrompt(terminalId)
  }

  settledSince(terminalId: string): number | undefined {
    return this.deliveries.settledSince(terminalId)
  }

  ready(terminalId: string): boolean {
    return this.deliveries.ready(terminalId)
  }

  byScreen(terminalId: string): boolean {
    return this.deliveries.byScreen(terminalId)
  }

  stamp(terminalId: string): string {
    return this.deliveries.stamp(terminalId)
  }

  idleWaiting(terminalId: string): boolean {
    return this.deliveries.idleWaiting(terminalId)
  }

  pendingSubmission(terminalId: string, startedAt: number, firedAt?: number): number | undefined {
    return this.deliveries.pendingSubmission(terminalId, startedAt, firedAt)
  }

  ring(terminalId: string, nonce: string): boolean {
    return this.deliveries.ring(terminalId, nonce)
  }

  unconfirmed(terminalId: string, nonce: string): boolean {
    return this.deliveries.unconfirmed(terminalId, nonce)
  }

  ringLeftover(terminalId: string, nonce: string): boolean {
    return this.deliveries.ringLeftover(terminalId, nonce)
  }

  ringing(terminalId: string): string | undefined {
    return this.deliveries.ringing(terminalId)
  }

  ringFailed(terminalId: string, nonce: string): void {
    this.deliveries.ringFailed(terminalId, nonce)
  }

  // What hooks print, and the leases of it: see `HookAnswers`, `Leasing` and `Withdrawals`.

  observe(terminalId: string, events: readonly HarnessEvent[], person?: Person): void {
    this.hookAnswers.observe(terminalId, events, person)
  }

  ask(terminalId: string, report: Parameters<HookAnswers["ask"]>[1]): Answer {
    return this.hookAnswers.ask(terminalId, report)
  }

  acknowledge(terminalId: string, leaseId: string): void {
    this.leasing.acknowledge(terminalId, leaseId)
  }

  lapsed(terminalId: string, binding: Binding, turnAt: number): ActivityEvent | undefined {
    return this.leasing.lapsed(terminalId, binding, turnAt)
  }

  automatic(terminalId: string, text: string): void {
    this.withdrawals.automatic(terminalId, text)
  }

  automaticFailed(terminalId: string, text: string): void {
    this.withdrawals.automaticFailed(terminalId, text)
  }

  // Holds: see `Holds`.

  heldFrom(terminalId: string): readonly string[] {
    return this.holds.heldFrom(terminalId)
  }

  release(threadId: string): void {
    this.holds.release(threadId)
  }

  stop(threadId: string): void {
    this.holds.stop(threadId)
  }

  // Leads: see `Leading`.

  endLead(terminalId: string): void {
    this.leading.endLead(terminalId)
  }

  setLead(terminalId: string, handle: string): void {
    // The grants that now cover it reach it as the sessions change (`Grants.reach`).
    this.leading.setLead(terminalId, handle)
  }

  sendBrief(terminalId: string, request: unknown): SendAnswer {
    return this.leading.sendBrief(terminalId, request)
  }

  briefOf(terminalId: string): string | undefined {
    return this.leading.briefOf(terminalId)
  }

  dropLeadMessages(terminalId: string): void {
    this.leading.dropLeadMessages(terminalId)
  }

  leadOf(terminalId: string): string | undefined {
    return this.leading.leadOf(terminalId)
  }

  // Agents' messages and listings: see `Sending`.

  send(terminalId: string, request: unknown, about?: About): SendAnswer {
    return this.sending.send(terminalId, request, about)
  }

  sendAny(terminalId: string, request: unknown, about?: About): SendAnswer | TeamAnswer {
    return this.sending.sendAny(terminalId, request, about)
  }

  agentIn(terminalId: string): Deliverable | undefined {
    return this.sending.agentIn(terminalId)
  }

  refusal(terminalId: string, text: string, agent: AgentName): string | undefined {
    return this.sending.refusal(terminalId, text, agent)
  }

  describes(terminalId: string, request: unknown): boolean {
    return this.sending.describes(terminalId, request)
  }

  peer(terminalId: string, to: string, about?: About): PeerAnswer {
    return this.sending.peer(terminalId, to, about)
  }

  agents(terminalId: string, about?: About, request?: unknown): AgentsAnswer {
    return this.sending.agents(terminalId, about, request)
  }

  goneFrom(terminalId: string): ReturnType<Sending["goneFrom"]> {
    return this.sending.goneFrom(terminalId)
  }

  onTheWay(from: string, to: string): readonly OnTheWay[] {
    return this.sending.onTheWay(from, to)
  }

  waitingFor(terminalId: string, except: string): number {
    return this.sending.waitingFor(terminalId, except)
  }

  list(terminalId: string, handle: string): TerminalMessages {
    return this.sending.list(terminalId, handle)
  }

  deliveredAt(terminalId: string): number | null {
    return this.sending.deliveredAt(terminalId)
  }

  // The person's replies and Novadeck's notices: see `Relays`.

  inboxOwner(terminalId: string): InboxOwner | undefined {
    return this.relays.inboxOwner(terminalId)
  }

  personReply(...reply: Parameters<Relays["personReply"]>): void {
    this.relays.personReply(...reply)
  }

  personFeedbackRequest(terminalId: string, requestId: string, hint: string): void {
    this.relays.personFeedbackRequest(terminalId, requestId, hint)
  }

  notice(terminalId: string, text: string, options?: { always?: boolean }): boolean {
    return this.relays.notice(terminalId, text, options)
  }

  // The log of long waits: see `LongWaits`.

  tellWaits(): void {
    this.waits.tell()
  }

  waitedMs(terminalId: string): number | null {
    return this.waits.waitedMs(terminalId)
  }
}
