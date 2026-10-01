import type { AgentName, MessageThread, TerminalMessages } from "@novadeck/protocol"
import { z } from "zod"

import { DomainError } from "../errors.js"
import type { HarnessEvent } from "../harnesses/events.js"
import { agents as allAgents, harnesses } from "../harnesses/registry.js"
import { rootedIn, type Root, type RootChange } from "../harnesses/roots.js"
import type { HookAnswer } from "../shell/reports.js"
import {
  continues,
  phaseOf,
  route,
  running,
  transition,
  unbound,
  type Delivery,
  type DeliveryEvent,
} from "./delivery.js"
import { Leases, type Lease } from "./leases.js"
import {
  allowSend,
  byteLength,
  cleanText,
  deliveryOf,
  duplicateOf,
  freshId,
  holdOf,
  hopsPerRelease,
  maxDeliveryBytes,
  maxMessageBytes,
  maxUndelivered,
  rates,
  retentionMs,
  threadBetween,
  undelivered,
  waiting,
  wrap,
  type Message,
  type Thread,
} from "./mailbox.js"
import { lastBetween, peerOf, renderAgents, unknownHandle, type About, type Peer } from "./peers.js"
import { memoryMailbox, type MailboxRecords } from "./records.js"

/** Which terminals see each other: those of one project and one NovaDeck session. */
export type Scope = { readonly projectId: string; readonly sessionId: string }

/** A running terminal, as messaging knows it. */
type Live = Scope & {
  readonly terminalId: string
  readonly handle: string
  /** Its root session, as the terminal manager follows it. */
  root: Root | null
  delivery: Delivery
  /**
   * The agent expected to bind there, which messages may be addressed to before it has;
   * none once a root session has, when only a bound session takes messages.
   */
  expecting: AgentName | null
}

/** What `send` answers: where the message is, or why it was refused. */
export type SendAnswer =
  | {
      readonly ok: true
      readonly to: string
      readonly id: string
      readonly state: Message["state"]
      /** When a queued message reaches its recipient. */
      readonly route?: string
      /** Why a held message waits. */
      readonly held?: "paused" | "release"
      /** Earlier messages from this terminal that won't arrive, told once. */
      readonly gone?: readonly { readonly id: string; readonly to: string }[]
      /** This terminal's own session never bound, so replies can't reach it. */
      readonly unbound?: true
    }
  | { readonly ok: false; readonly reason: string }

/** What `agents` answers: the listing, rendered once, as agents read it. */
export type AgentsAnswer =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string }

export type MessagingOptions = {
  /** Where messages, threads and the pause are kept; in memory when omitted. */
  readonly records?: MailboxRecords
  readonly now?: () => number
  /** How long a lease waits for its hook's acknowledgement, in milliseconds. */
  readonly leaseMs?: number
  /** How often messages past retention are deleted, in milliseconds. */
  readonly sweepMs?: number
  /**
   * How long after the runner starts its terminals have to be restored and their agents
   * resumed, in milliseconds: then messages for a session not running are gone, until it
   * runs again.
   */
  readonly restoreMs?: number
  /** Whether a terminal exists, running or kept; one running counts when omitted. */
  readonly exists?: (terminalId: string) => boolean
  /**
   * Hears of every change to a terminal's messages or delivery state, as a doorbell or a
   * watch that follows them would.
   */
  readonly onChange?: (terminalId: string) => void
}

/** A lease is given only with this long left before its hook's deadline, in milliseconds. */
export const leaseMargin = 300

const sendRequest = z.strictObject({
  to: z.string().min(1).max(64),
  text: z.string().max(64 * 1024),
})

const refused = (reason: string) => ({ ok: false, reason }) as const

/** When a thread's latest message was sent. */
const latest = (thread: MessageThread): number => thread.messages.at(-1)?.sentAt ?? 0

/** The bytes the largest of a message's deliveries on its own would print, in any harness. */
const deliveredBytes = (message: Message): number => {
  const text = wrap([message])
  return Math.max(
    ...allAgents.flatMap((agent) => {
      const { messaging } = harnesses[agent]
      return [byteLength(messaging.stop(text)), byteLength(messaging.prompt(text))]
    }),
  )
}

/**
 * Messages between the agents in NovaDeck's terminals (see docs/agent-messaging.md): the
 * mailbox, which keeps every message and thread; each terminal's delivery state; and its
 * leases (`leases.ts`) and descriptions of peers (`peers.ts`). The terminal manager owns
 * the terminals, their handles, roots and work, tells it what their agents and people
 * do, and asks it what each hook prints.
 */
export class Messaging {
  private readonly records: MailboxRecords
  private readonly now: () => number
  private readonly exists: (terminalId: string) => boolean
  private readonly onChange: (terminalId: string) => void
  private readonly live = new Map<string, Live>()
  private readonly messages = new Map<string, Message>()
  private readonly threads = new Map<string, Thread>()
  private readonly leases: Leases
  private paused: boolean
  // Send times, for the rates: by sender, by sender and recipient, and all.
  private readonly sent = new Map<string, readonly number[]>()
  private readonly pairs = new Map<string, readonly number[]>()
  private allSent: readonly number[] = []
  private readonly sweeper: ReturnType<typeof setInterval> | undefined
  private readonly restoring: ReturnType<typeof setTimeout> | undefined

  constructor(options: MessagingOptions = {}) {
    this.records = options.records ?? memoryMailbox()
    this.now = options.now ?? Date.now
    this.exists = options.exists ?? ((terminalId) => this.live.has(terminalId))
    this.onChange = options.onChange ?? (() => {})
    this.leases = new Leases(options.leaseMs ?? 5_000, (lease) => this.lapse(lease))
    this.paused = this.read(() => this.records.messagingPaused(), false)
    for (const thread of this.read(() => this.records.threads(), []))
      this.threads.set(thread.id, thread)
    for (const message of this.read(() => this.records.messages(), [])) {
      this.messages.set(message.id, message)
      // A lease held when the runner stopped is gone with it: its messages wait again.
      if (message.state === "leased" || message.state === "queued" || message.state === "held")
        this.wait(message)
    }
    this.sweep()
    if (options.sweepMs !== 0) {
      this.sweeper = setInterval(() => this.sweep(), options.sweepMs ?? 60 * 60_000)
      this.sweeper.unref()
    }
    if (options.restoreMs !== 0) {
      this.restoring = setTimeout(() => this.restored(), options.restoreMs ?? 120_000)
      this.restoring.unref()
    }
  }

  /** Stops its timers; leases left go back to waiting with the next runner. */
  close(): void {
    clearInterval(this.sweeper)
    clearTimeout(this.restoring)
    this.leases.clear()
  }

  /**
   * A terminal starts, or starts again, with the handle its record keeps. It sees, and is
   * seen by, the terminals of its project and NovaDeck session.
   */
  register(terminalId: string, scope: Scope, handle: string): void {
    if (this.live.has(terminalId)) return
    this.live.set(terminalId, {
      terminalId,
      ...scope,
      handle,
      root: null,
      delivery: unbound,
      expecting: null,
    })
  }

  /**
   * A terminal stops running, as it exits or closes: every message for it is gone, those
   * waiting for its first session too, until its session runs there again.
   */
  unregister(terminalId: string): void {
    const live = this.live.get(terminalId)
    if (!live) return
    this.applyRoot(live, [{ type: "ended" }])
    for (const message of this.messages.values())
      if (message.to.terminalId === terminalId && undelivered(message)) this.gone(message)
    this.live.delete(terminalId)
  }

  /** The terminal's delivery state, while it runs. */
  delivery(terminalId: string): Delivery | undefined {
    return this.live.get(terminalId)?.delivery
  }

  /**
   * Expects an agent to bind in the terminal, as one it was opened to run: messages may
   * be addressed to it before it has, and wait for its first session. The expectation
   * ends once any root session binds there.
   */
  expect(terminalId: string, agent: AgentName | null): void {
    const live = this.live.get(terminalId)
    if (live) live.expecting = agent
  }

  /** Whether messages wait, or went, for that session of the terminal. */
  awaits(terminalId: string, sessionId: string): boolean {
    for (const message of this.messages.values())
      if (
        message.to.terminalId === terminalId &&
        message.to.sessionId === sessionId &&
        (undelivered(message) || message.state === "gone")
      )
        return true
    return false
  }

  /** How the terminal's root changed, as the terminal manager follows it (`followRoot`). */
  rooted(terminalId: string, changes: readonly RootChange[]): void {
    const live = this.live.get(terminalId)
    if (live) this.applyRoot(live, changes)
  }

  /** What the terminal's root session did, decoded from a report, for its delivery state. */
  observe(terminalId: string, events: readonly HarnessEvent[]): void {
    const live = this.live.get(terminalId)
    if (!live) return
    for (const event of events) this.turn(live, event)
  }

  /**
   * What a Stop or prompt-time hook prints, as it asks once its report is applied: the
   * messages waiting for the terminal's root session, leased to it, when its report is a
   * root turn event that may take them and its `deadline` leaves time to print them. A
   * harness whose injected messages last one call gets a turn's delivery again on each
   * later call of it.
   */
  ask(
    terminalId: string,
    report: {
      readonly agent: AgentName
      readonly event: string
      readonly events: readonly HarnessEvent[]
      readonly deadline: number
    },
  ): HookAnswer {
    const profile = harnesses[report.agent].messaging
    const silent = { leaseId: null, stdout: profile.silent(report.event) }
    const kind = profile.asks[report.event]
    const live = this.live.get(terminalId)
    if (!live) return silent
    if (!kind) {
      this.observe(terminalId, report.events)
      return silent
    }
    const root = live.root
    // The Stop is this ask's own to settle, by whether it continues the turn.
    const stop =
      kind === "stop"
        ? report.events.find(
            (event): event is Extract<HarnessEvent, { type: "turn-ended" }> =>
              event.type === "turn-ended" && event.outcome === "completed" && rootedIn(root, event),
          )
        : undefined
    for (const event of report.events) if (event !== stop) this.turn(live, event)
    if (!root) return silent
    const time = report.deadline - this.now() >= leaseMargin
    if (stop) {
      const background = stop.background === true
      const lease = time && continues(live.delivery) && this.lease(live, root, "stop", background)
      this.step(live, { type: "stop", continued: Boolean(lease), background })
      return lease ? { leaseId: lease.id, stdout: profile.stop(lease.text) } : silent
    }
    if (kind !== "prompt") return silent
    const start = report.events.find(
      (event): event is Extract<HarnessEvent, { type: "turn-started" }> =>
        event.type === "turn-started" && rootedIn(root, event),
    )
    if (!start) return silent
    // A later model call of the turn sees again what its first was given.
    const kept = profile.reinjectPerCall
      ? this.leases.recall(terminalId, live.delivery.epoch)
      : undefined
    const again = kept === undefined ? undefined : profile.prompt(kept)
    if (start.cause === "call") return again ? { leaseId: null, stdout: again } : silent
    const lease = time && this.lease(live, root, "prompt", false)
    if (lease) return { leaseId: lease.id, stdout: profile.prompt(lease.text) }
    return again ? { leaseId: null, stdout: again } : silent
  }

  /**
   * A hook printed what its lease delivers: its messages are delivered. An ack for a
   * lease that lapsed, was given again, or is another terminal's, is ignored.
   */
  acknowledge(terminalId: string, leaseId: string): void {
    const lease = this.leases.take(terminalId, leaseId)
    if (!lease) return
    const at = this.now()
    for (const id of lease.messages) {
      const message = this.messages.get(id)
      if (message?.state === "leased") this.put({ ...message, state: "delivered", deliveredAt: at })
    }
    const root = this.live.get(terminalId)?.root
    if (lease.kind === "prompt" && root && harnesses[root.agent].messaging.reinjectPerCall)
      this.leases.remember(terminalId, lease.epoch, lease.text)
  }

  /**
   * The person's input to the terminal, apart from its automatic replies: a prompt they
   * `submit`, unless it `answers` a request waiting on them.
   */
  input(terminalId: string, input: { readonly submits: boolean; readonly answers: boolean }): void {
    const live = this.live.get(terminalId)
    if (live) this.step(live, { type: "input", ...input })
  }

  /**
   * Whether `send` would answer this request by describing the terminals there, as its
   * `to` is no current handle of theirs; only then does it need their whereabouts.
   */
  describes(terminalId: string, request: unknown): boolean {
    const live = this.live.get(terminalId)
    const parsed = sendRequest.safeParse(request)
    if (!live || !parsed.success) return false
    return !this.scoped(live).some((peer) => peer.handle === parsed.data.to)
  }

  /**
   * An agent's message to another terminal in its project and session, by that
   * terminal's exact handle. It never claims delivery: it answers where the message is,
   * or why not, describing every terminal there when `to` is no current handle.
   */
  send(terminalId: string, request: unknown, about: About = () => undefined): SendAnswer {
    const live = this.live.get(terminalId)
    if (!live) return refused("NovaDeck couldn't send the message.")
    const parsed = sendRequest.safeParse(request)
    if (!parsed.success)
      return refused("A message needs `to`, a terminal's handle, and its `text`.")
    const text = cleanText(parsed.data.text)
    if (!text.trim()) return refused("The message is empty.")
    if (byteLength(text) > maxMessageBytes)
      return refused(
        `The message is ${byteLength(text)} bytes, over the ${maxMessageBytes} a message may ` +
          "hold; put longer content in a file the recipient can open, and send its path.",
      )
    const recipient = this.scoped(live).find((peer) => peer.handle === parsed.data.to)
    if (!recipient)
      return refused(
        unknownHandle(parsed.data.to, live.handle, this.peers(live, about), this.now()),
      )
    const root = recipient.root
    const agent = root?.agent ?? recipient.expecting
    if (!agent)
      return refused(`${recipient.handle} has no agent running there that NovaDeck can deliver to.`)
    const now = this.now()
    const same = duplicateOf(this.messages.values(), terminalId, recipient.terminalId, text, now)
    if (same) return { ...this.answer(same, recipient), ...this.extras(live) }
    const known = threadBetween(this.threads.values(), terminalId, recipient.terminalId, now)
    const thread: Thread = known
      ? { ...known, hops: known.hops + 1, lastAt: now }
      : {
          id: this.freshThreadId(),
          projectId: live.projectId,
          between: [terminalId, recipient.terminalId],
          hops: 1,
          allowed: hopsPerRelease,
          lastAt: now,
        }
    const message: Message = {
      id: this.freshMessageId(),
      projectId: live.projectId,
      thread: thread.id,
      hop: thread.hops,
      from: {
        terminalId,
        handle: live.handle,
        agent: live.root?.agent ?? null,
        sessionId: live.root?.sessionId ?? null,
      },
      to: {
        terminalId: recipient.terminalId,
        handle: recipient.handle,
        agent,
        sessionId: root?.sessionId ?? null,
      },
      text,
      sentAt: now,
      state: waiting({ hop: thread.hops }, thread, this.paused),
      deliveredAt: null,
      notified: false,
    }
    // Alone in a delivery, it must fit whichever harness it reaches, as it is printed.
    const size = deliveredBytes(message)
    if (size > maxDeliveryBytes)
      return refused(
        `Delivered, this message would take ${size} bytes, over the ${maxDeliveryBytes} a ` +
          'delivery may: plain text of up to 4 KB fits, but characters such as < > & " and ' +
          "line breaks take more room once escaped. Shorten it, or put it in a file and send " +
          "its path.",
      )
    const waitingThere = [...this.messages.values()].filter(
      (each) => each.to.terminalId === recipient.terminalId && undelivered(each),
    ).length
    if (waitingThere >= maxUndelivered)
      return refused(
        `${recipient.handle} already has ${maxUndelivered} messages waiting; ` +
          "wait for it to take them before sending more.",
      )
    const pair = `${terminalId}\0${recipient.terminalId}`
    const bySender = allowSend(this.sent.get(terminalId) ?? [], now, rates.sender)
    const byPair = allowSend(this.pairs.get(pair) ?? [], now, rates.pair)
    const byAll = allowSend(this.allSent, now, rates.all)
    if (!bySender || !byPair)
      return refused(
        `An agent may send ${rates.sender} messages a minute, ${rates.pair} of them to any ` +
          "one terminal; try again shortly.",
      )
    if (!byAll)
      return refused(
        "Agents in NovaDeck have sent as many messages as they may this minute; try again shortly.",
      )
    this.sent.set(terminalId, bySender)
    this.pairs.set(pair, byPair)
    this.allSent = byAll
    this.putThread(thread)
    this.put(message)
    return { ...this.answer(message, recipient), ...this.extras(live) }
  }

  /**
   * The other terminals in the caller's project and session, each described by what
   * NovaDeck knows of it, and the caller's own messages not yet delivered or gone, as one
   * text agents read.
   */
  agents(terminalId: string, about: About = () => undefined): AgentsAnswer {
    const live = this.live.get(terminalId)
    if (!live) return refused("NovaDeck couldn't list the terminals.")
    const mine = [...this.messages.values()]
      .filter(
        (message) =>
          message.from.terminalId === terminalId &&
          (undelivered(message) || message.state === "gone"),
      )
      .toSorted((a, b) => a.sentAt - b.sentAt)
    for (const message of mine)
      if (message.state === "gone" && !message.notified) this.put({ ...message, notified: true })
    const text = renderAgents({
      handle: live.handle,
      peers: this.peers(live, about),
      messages: mine.map((message) => ({ message, hold: this.holdOf(message) })),
      unbound: live.root === null,
      now: this.now(),
    })
    return { ok: true, text }
  }

  /**
   * The terminal's threads and messages with their states, for the runner API; an exited
   * terminal's too, while its messages are kept.
   */
  list(terminalId: string, handle: string): TerminalMessages {
    const live = this.live.get(terminalId)
    const mine = [...this.messages.values()]
      .filter(({ from, to }) => from.terminalId === terminalId || to.terminalId === terminalId)
      .toSorted((a, b) => a.sentAt - b.sentAt)
    const byThread = new Map<string, Message[]>()
    for (const message of mine)
      byThread.set(message.thread, [...(byThread.get(message.thread) ?? []), message])
    const threads: MessageThread[] = [...byThread].map(([id, messages]) => {
      const thread = this.threads.get(id)
      const [first] = messages
      const peer = first!.from.terminalId === terminalId ? first!.to.handle : first!.from.handle
      return {
        id,
        peer,
        hops: thread?.hops ?? messages.length,
        allowed: thread?.allowed ?? hopsPerRelease,
        held: messages.some(
          (message) => message.state === "held" && this.holdOf(message) === "release",
        ),
        messages: messages.slice(-1000).map((message) => ({
          id: message.id,
          thread: message.thread,
          hop: message.hop,
          from: message.from.handle,
          fromAgent: message.from.agent,
          to: message.to.handle,
          toAgent: message.to.agent,
          text: message.text,
          sentAt: message.sentAt,
          state: message.state,
          held: message.state === "held" ? this.holdOf(message) : null,
          deliveredAt: message.deliveredAt,
        })),
      }
    })
    return {
      terminalId,
      handle,
      delivery: live?.delivery.state ?? "unbound",
      paused: this.paused,
      threads: threads.toSorted((a, b) => latest(b) - latest(a)).slice(0, 1000),
    }
  }

  /** Whether messaging is paused, across the whole runner. */
  isPaused(): boolean {
    return this.paused
  }

  /**
   * Pauses messaging across the whole runner, or resumes it, keeping the switch: waiting
   * messages are held while paused, and wait in order again once resumed.
   */
  pause(paused: boolean): void {
    this.write(() => this.records.pauseMessaging(paused))
    this.paused = paused
    for (const message of this.messages.values())
      if (message.state === "queued" || message.state === "held") this.wait(message)
  }

  /** Releases a thread: its held messages wait to be delivered, and it may have 12 more. */
  release(threadId: string): void {
    const thread = this.threads.get(threadId)
    if (!thread) throw new DomainError("NOT_FOUND")
    this.putThread({ ...thread, allowed: thread.hops + hopsPerRelease })
    for (const message of this.messages.values())
      if (message.thread === threadId && message.state === "held") this.wait(message)
  }

  /**
   * Deletes each message once neither of its terminals exists and its latest activity is
   * a day old, and the threads only they kept.
   */
  sweep(): void {
    const now = this.now()
    const old = [...this.messages.values()].filter(
      (message) =>
        !this.exists(message.from.terminalId) &&
        !this.exists(message.to.terminalId) &&
        now - Math.max(message.sentAt, message.deliveredAt ?? 0) >= retentionMs,
    )
    for (const { id } of old) this.messages.delete(id)
    if (old.length > 0) this.write(() => this.records.removeMessages(old.map(({ id }) => id)))
    const kept = new Set([...this.messages.values()].map(({ thread }) => thread))
    const threads = [...this.threads.keys()].filter((id) => !kept.has(id))
    for (const id of threads) this.threads.delete(id)
    if (threads.length > 0) this.write(() => this.records.removeThreads(threads))
  }

  /**
   * Restoring is over: messages for a session that doesn't run in their terminal, as one
   * never restored, are gone, and wait again should that session run there. Those waiting
   * for a terminal's first session wait on.
   */
  private restored(): void {
    for (const message of this.messages.values()) {
      if (!undelivered(message) || message.state === "leased") continue
      if (message.to.sessionId === null) continue
      const live = this.live.get(message.to.terminalId)
      if (live?.root && this.addressed(message, live.root)) continue
      this.gone(message)
    }
  }

  /** The other running terminals in the terminal's project and session. */
  private scoped(live: Live): Live[] {
    return [...this.live.values()].filter(
      (peer) =>
        peer.projectId === live.projectId &&
        peer.sessionId === live.sessionId &&
        peer.terminalId !== live.terminalId,
    )
  }

  /** The caller's peers, described. */
  private peers(live: Live, about: About): Peer[] {
    return this.scoped(live).map((peer) =>
      peerOf({
        terminalId: peer.terminalId,
        handle: peer.handle,
        agent: peer.root?.agent ?? null,
        expecting: peer.root ? null : peer.expecting,
        busy: peer.delivery.state === "working",
        where: about(peer.terminalId),
        withYou: lastBetween(this.messages.values(), live.terminalId, peer),
      }),
    )
  }

  /** What `send` answers of a message to `recipient`. */
  private answer(message: Message, recipient: Live): SendAnswer {
    const base = { ok: true, to: message.to.handle, id: message.id, state: message.state } as const
    if (message.state === "held") {
      const held = this.holdOf(message)
      return held ? { ...base, held } : base
    }
    if (message.state !== "queued") return base
    const agent = recipient.root?.agent
    return {
      ...base,
      route: agent
        ? route(recipient.delivery, harnesses[agent].messaging.silentOnFailure)
        : "when its agent first prompts",
    }
  }

  /** What every answer to the sender adds: its messages newly gone, and whether replies reach it. */
  private extras(live: Live) {
    const gone = [...this.messages.values()].filter(
      (message) =>
        message.from.terminalId === live.terminalId &&
        message.state === "gone" &&
        !message.notified,
    )
    for (const message of gone) this.put({ ...message, notified: true })
    return {
      ...(gone.length > 0 && {
        gone: gone.map((message) => ({ id: message.id, to: message.to.handle })),
      }),
      ...(live.root === null && { unbound: true as const }),
    }
  }

  private holdOf(message: Message): "paused" | "release" | null {
    return holdOf(message, this.threads.get(message.thread), this.paused)
  }

  /** Puts an undelivered message back to waiting: held for a reason, else queued. */
  private wait(message: Message): void {
    const state = waiting(message, this.threads.get(message.thread), this.paused)
    if (state !== message.state) this.put({ ...message, state })
  }

  private gone(message: Message): void {
    this.put({ ...message, state: "gone", notified: false })
  }

  /**
   * Leases the messages waiting for the root session, as many as one delivery carries
   * once printed as its harness reads it, until the hook acknowledges them; none when
   * none wait.
   */
  private lease(
    live: Live,
    root: Root,
    kind: Lease["kind"],
    background: boolean,
  ): Lease | undefined {
    const queued = [...this.messages.values()]
      .filter(({ state, ...message }) => state === "queued" && this.addressed(message, root))
      .filter(({ to }) => to.terminalId === live.terminalId)
      .toSorted((a, b) => a.sentAt - b.sentAt)
    const { messaging } = harnesses[root.agent]
    const encode = kind === "stop" ? messaging.stop : messaging.prompt
    const messages = deliveryOf(
      queued,
      (taken) => byteLength(encode(wrap(taken))) <= maxDeliveryBytes,
    )
    if (messages.length === 0) return undefined
    for (const message of messages) this.put({ ...message, state: "leased" })
    return this.leases.grant({
      terminalId: live.terminalId,
      messages: messages.map((message) => message.id),
      kind,
      epoch: live.delivery.epoch,
      background,
      text: wrap(messages),
    })
  }

  /**
   * A lease its hook never acknowledged: its messages wait again. A Stop it would have
   * continued was not continued, so its turn ended there, unless the turn has moved on
   * since, as when the hook printed it and only its acknowledgement was lost.
   */
  private lapse(lease: Lease): void {
    for (const id of lease.messages) {
      const message = this.messages.get(id)
      if (message?.state === "leased") this.wait(message)
    }
    const live = this.live.get(lease.terminalId)
    if (!live || lease.kind !== "stop") return
    const { delivery } = live
    if (delivery.epoch === lease.epoch && phaseOf(delivery) === "continuing")
      this.step(live, { type: "stop", continued: false, background: lease.background })
  }

  /** Applies the root's changes to the terminal's messages and delivery, in order. */
  private applyRoot(live: Live, changes: readonly RootChange[]): void {
    for (const change of changes) {
      if (change.type === "ended") {
        if (!live.root) continue
        live.root = null
        this.step(live, { type: "unbound" })
        // Messages for the session that ended are gone; those for the first session the
        // terminal expects wait on, until it closes.
        for (const message of this.messages.values())
          if (
            message.to.terminalId === live.terminalId &&
            message.to.sessionId !== null &&
            undelivered(message)
          )
            this.gone(message)
      } else if (change.type === "new") this.rootAt(live, change.root, change.guess)
      else this.correct(live, change.from, change.root, change.confirmed)
    }
  }

  /**
   * A new root session in the terminal: its messages that were gone wait again, and those
   * waiting for the terminal's first session of that agent are now its own, while another
   * agent's are gone. Unless the root is only a guess, messages for any other session
   * there are gone, as after a runner restart.
   */
  private rootAt(live: Live, root: Root, guess: boolean): void {
    live.root = root
    // Its first session came: from now on, only a bound session takes messages.
    live.expecting = null
    this.step(live, { type: "bound" })
    for (const message of this.messages.values()) {
      if (message.to.terminalId !== live.terminalId) continue
      if (message.to.sessionId === null) {
        if (!undelivered(message)) continue
        if (message.to.agent === root.agent)
          this.put({ ...message, to: { ...message.to, sessionId: root.sessionId } })
        else this.gone(message)
      } else if (this.addressed(message, root)) {
        if (message.state === "gone") this.wait(message)
      } else if (!guess && undelivered(message)) this.gone(message)
    }
  }

  /**
   * Corrects the root's session, as a guess at it is replaced by a better one: messages
   * sent to the guess go to it, and its own that were gone wait again. Once its status
   * line names it, messages for any other session there are gone.
   */
  private correct(live: Live, from: string, root: Root, confirmed: boolean): void {
    live.root = root
    for (const message of this.messages.values()) {
      const { to } = message
      if (to.terminalId !== live.terminalId) continue
      if (to.agent === root.agent && to.sessionId === from && from !== root.sessionId) {
        if (undelivered(message)) this.put({ ...message, to: { ...to, sessionId: root.sessionId } })
      } else if (this.addressed(message, root)) {
        if (message.state === "gone") this.wait(message)
      } else if (confirmed && to.sessionId !== null && undelivered(message)) this.gone(message)
    }
  }

  private addressed(message: Pick<Message, "to">, root: Root): boolean {
    return message.to.agent === root.agent && message.to.sessionId === root.sessionId
  }

  /** Applies a root turn event to the terminal's delivery. */
  private turn(live: Live, event: HarnessEvent): void {
    if (!rootedIn(live.root, event)) return
    switch (event.type) {
      case "turn-started":
        this.step(live, { type: "prompt", by: event.cause === "prompt" ? "person" : event.cause })
        return
      case "turn-ended":
        if (event.outcome === "completed")
          this.step(live, { type: "stop", continued: false, background: event.background === true })
        else this.step(live, { type: "ended" })
        return
      case "turn-idle":
        this.step(live, { type: "idle", background: event.background })
        return
      default:
        return
    }
  }

  private step(live: Live, event: DeliveryEvent): void {
    const before = live.delivery
    live.delivery = transition(before, event)
    if (live.delivery === before) return
    // A turn that ended, or a new one, leaves the last one's delivery behind.
    if ((running(before) && !running(live.delivery)) || live.delivery.epoch !== before.epoch)
      this.leases.forget(live.terminalId)
    this.onChange(live.terminalId)
  }

  private freshMessageId(): string {
    let id = freshId("m")
    while (this.messages.has(id)) id = freshId("m")
    return id
  }

  private freshThreadId(): string {
    let id = freshId("t")
    while (this.threads.has(id)) id = freshId("t")
    return id
  }

  private put(message: Message): void {
    this.messages.set(message.id, message)
    this.write(() => this.records.saveMessage(message))
    this.onChange(message.to.terminalId)
    this.onChange(message.from.terminalId)
  }

  private putThread(thread: Thread): void {
    this.threads.set(thread.id, thread)
    this.write(() => this.records.saveThread(thread))
  }

  /** Reads the records; a failure is logged and gives `fallback`. */
  private read<T>(work: () => T, fallback: T): T {
    try {
      return work()
    } catch (error) {
      console.error("NovaDeck could not read its messages:", error)
      return fallback
    }
  }

  /** Writes to the records; a failure is logged, and the runner carries on. */
  private write(work: () => void): void {
    try {
      work()
    } catch (error) {
      console.error("NovaDeck could not save its messages:", error)
    }
  }
}
