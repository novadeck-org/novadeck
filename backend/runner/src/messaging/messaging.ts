import type { ActivityEvent, Background, HarnessEvent } from "@novadeck/harness-core/events"
import { hookShellSlackMs, silentFor, type MessagingProfile } from "@novadeck/harness-core/harness"
import {
  longHoldMs,
  type AgentName,
  type MessageThread,
  type TerminalMessages,
} from "@novadeck/protocol"
import type { KeyKind } from "@novadeck/tui-input"
import { z } from "zod"

import { DomainError } from "../errors.js"
import type { Binding } from "../harnesses/bindings.js"
import { agents as allAgents, harnesses } from "../harnesses/registry.js"
import { rootedIn, type Root, type RootChange } from "../harnesses/roots.js"
import type { HookAnswer } from "../shell/reports.js"
import { bareHandle, mention } from "../terminals/handles.js"
import {
  continues,
  phaseOf,
  ringableSince,
  midTurnCall,
  route,
  running,
  transition,
  unbound,
  type Delivery,
  firing,
  pendingEnter,
  type DeliveryEvent,
  queueBarLeft,
  type Waits,
  waitReasons,
  waitsIn,
} from "./delivery.js"
import { Leases, type Lease } from "./leases.js"
import {
  allowSend,
  byteLength,
  cleanText,
  clock,
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
  stopBlocks,
  stoppedBetween,
  threadBetween,
  undelivered,
  waiting,
  markLength,
  newMark,
  wrap,
  type Message,
  type Thread,
} from "./mailbox.js"
import {
  lastBetween,
  peerOf,
  renderAgents,
  unknownHandle,
  untrustedNote,
  type About,
  type Peer,
} from "./peers.js"
import { memoryMailbox, type MailboxRecords } from "./records.js"

/** Which terminals see each other: those of one project and one Novadeck session. */
export type Scope = { readonly projectId: string; readonly sessionId: string }

/** A running terminal, as messaging knows it. */
type Live = Scope & {
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
  /** When the person's last key came; the doorbell's screen look before it is stale. */
  keyedAt: number
  /** Why the doorbell last found the idle agent unringable, from its screen; null if not. */
  waits: Waits | null
  /** Since when `waits` has said why, without a break, whatever it said; null with none. */
  waitsSince: number | null
  /**
   * The nonces of its latest rings that no doorbell prompt confirmed, oldest first: a line
   * of one left alone in its box is Novadeck's to submit. A confirmed one's line in the box
   * is the person's: put back by their Escape, or recalled from the prompt's history.
   */
  unconfirmed: readonly string[]
  /** Whether it is Ready because its screen showed the box empty, not a session's start. */
  viaScreen: boolean
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
      readonly gone?: readonly {
        readonly id: string
        readonly to: string
        /** The person stopped the thread it was in. */
        readonly stopped?: true
      }[]
      /** Its messages held long behind what keeps their recipient from them, told once each hold. */
      readonly holds?: readonly string[]
      /** This terminal's own session never bound, so replies can't reach it. */
      readonly unbound?: true
    }
  | {
      readonly ok: false
      readonly reason: string
      /** This terminal's own session never bound, so replies can't reach it. */
      readonly unbound?: true
    }

/**
 * A terminal an agent named among its peers: its id, its handle, and the agent running
 * there, if any; or why none is.
 */
export type PeerAnswer =
  | {
      readonly ok: true
      readonly terminalId: string
      readonly handle: string
      readonly agent: AgentName | null
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
   * The platform the harnesses' hooks run on, whose shells may hold a hook back (see
   * `hookShellSlackMs`); the runner's own when omitted.
   */
  readonly platform?: NodeJS.Platform
}

/**
 * A change listeners hear of: a terminal's messages, threads or delivery state changed, or
 * messaging was paused or resumed, which changes what every terminal's listing says.
 */
export type MessagingChange =
  | { readonly kind: "terminal"; readonly terminalId: string }
  | { readonly kind: "pause"; readonly paused: boolean }

/** What a doorbell prompt's hook adds when its messages couldn't come now. */
export const stillWaiting =
  "Novadeck: agent messages are still waiting for this session; they will come on a later turn, and this automatic notice can be ignored."

/** Message ids as a notice names them: the first few, then how many more. */
const named = (ids: readonly string[]): string =>
  ids.length <= 4 ? ids.join(", ") : `${ids.slice(0, 3).join(", ")} and ${ids.length - 3} more`

/**
 * What a sender is told of its messages held long behind what keeps their recipient's
 * doorbell from it (`waits`, since `since`), in its next answer or hook.
 */
export const holdNotice = (
  ids: readonly string[],
  to: string,
  waits: Waits,
  since: number,
): string =>
  `Novadeck: your ${ids.length === 1 ? "message" : "messages"} ${named(ids)} to ${mention(to)} ` +
  `${ids.length === 1 ? "has" : "have"} not arrived since ${clock(since)} ` +
  `(${waitReasons[waits]}); the user is shown this in Novadeck's Inbox.`

/** How many of a terminal's latest unconfirmed rings it remembers (`Live.unconfirmed`). */
const maxUnconfirmed = 8

/** What a doorbell prompt's hook adds when nothing waits for it any more. */
export const nothingWaiting =
  "Novadeck: no agent messages are waiting any more; this automatic notice can be ignored."

/** Why a message's text, cleaned, can't be sent; undefined when it can. */
const refusalOfText = (text: string): string | undefined => {
  if (!text.trim()) return "The message is empty."
  if (byteLength(text) > maxMessageBytes)
    return (
      `The message is ${byteLength(text)} bytes, over the ${maxMessageBytes} a message may ` +
      "hold; put longer content in a file the recipient can open, and send its path."
    )
  return undefined
}

/** A lease is given only with this long left before its hook's deadline, in milliseconds. */
export const leaseMargin = 300

/**
 * Whether subagents a turn left running run on, to wake its agent: delivery's
 * `background`. Work its harness doesn't count may be one, until its status line counts
 * it (Antigravity's); a command alone never holds delivery, as one may run for ever.
 */
const runsOn = (background: Background | undefined): boolean =>
  background !== undefined && (background.agents > 0 || background.more === true)

const sendRequest = z.strictObject({
  to: z.string().min(1).max(65).transform(bareHandle),
  text: z.string().max(64 * 1024),
})

const refused = (reason: string) => ({ ok: false, reason }) as const

// Closed, messaging keeps nothing more, so a message then would be lost, not queued.
const stopping = "Novadeck is stopping and couldn't keep the message; send it again once it's back."

/** What an ask's handlers share: its terminal, root, harness profile and the hook's report. */
type Asked = {
  readonly live: Live
  readonly root: Root
  readonly profile: MessagingProfile
  readonly silent: HookAnswer
  readonly events: readonly HarnessEvent[]
  readonly event: string
  /** Whether its deadline leaves time to lease and print. */
  readonly time: boolean
}

/** Whether a message is its recipient's lead's, as fixed when it was sent. */
const isFromLead = (message: Message): boolean => message.fromLead

/** What a turn already given a delivery prints beside a new one, as Antigravity's does. */
const joined = (kept: string | undefined, text: string): string =>
  kept ? `${kept}\n${text}` : text

/** A hook's delivery with the sender's hold notices after it, if any; empty with neither. */
const noted = (text: string | undefined, holds: readonly string[]): string =>
  [...(text ? [text] : []), ...holds].join("\n")

/** When a thread's latest message was sent. */
const latest = (thread: MessageThread): number => thread.messages.at(-1)?.sentAt ?? 0

/** The bytes the largest of a message's deliveries on its own would print, in any harness. */
const deliveredBytes = (message: Message): number => {
  // Agent mail uses the longer lead note. Person replies use their own note and nonce.
  const text = wrap([message], () => message.response === undefined, "x".repeat(markLength))
  return Math.max(
    ...allAgents.flatMap((agent) => {
      const { messaging } = harnesses[agent]
      // A tool-call hook carries a lead's message, under each name its events have.
      const tools = Object.entries(messaging.asks)
        .filter(([, kind]) => kind === "tool")
        .map(([event]) => byteLength(messaging.call?.(text, event) ?? ""))
      return [byteLength(messaging.stop(text)), byteLength(messaging.prompt(text)), ...tools]
    }),
  )
}

/**
 * Messages between the agents in Novadeck's terminals (see docs/agent-messaging.md): the
 * mailbox, which keeps every message and thread; each terminal's delivery state; and its
 * leases (`leases.ts`) and descriptions of peers (`peers.ts`). The terminal manager owns
 * the terminals, their handles, roots and work, tells it what their agents and people
 * do, and asks it what each hook prints.
 */
export class Messaging {
  private readonly records: MailboxRecords
  private readonly now: () => number
  /** How much later a hook may come, for the shell it starts in (see `firing`). */
  private readonly slackMs: number
  private readonly exists: (terminalId: string) => boolean
  /** Everyone following changes: the doorbell, and each `messages.watch`. */
  private readonly listeners = new Set<(change: MessagingChange) => void>()
  private readonly live = new Map<string, Live>()
  private readonly messages = new Map<string, Message>()
  /** Each queued message whose sender was told of its hold, by when that hold began. */
  private readonly holdsTold = new Map<string, number>()
  private readonly responses = new Map<string, string>()
  private readonly threads = new Map<string, Thread>()
  private readonly leases: Leases
  private paused: boolean
  // Send times, for the rates: by sender, by sender and recipient, and all.
  private readonly sent = new Map<string, readonly number[]>()
  private readonly pairs = new Map<string, readonly number[]>()
  private allSent: readonly number[] = []
  private readonly sweeper: ReturnType<typeof setInterval> | undefined
  private readonly restoring: ReturnType<typeof setTimeout> | undefined
  /**
   * Whether the runner closed it: what its end does to its terminals, each shell's exit
   * unregistering it, is the runner stopping, not its agents ending, so no message changes.
   */
  private closed = false

  constructor(options: MessagingOptions = {}) {
    this.records = options.records ?? memoryMailbox()
    this.now = options.now ?? Date.now
    this.slackMs = hookShellSlackMs(options.platform ?? process.platform)
    this.exists = options.exists ?? ((terminalId) => this.live.has(terminalId))
    this.leases = new Leases(options.leaseMs ?? 5_000, (lease) => this.lapse(lease))
    this.paused = this.read(() => this.records.messagingPaused(), false)
    for (const thread of this.read(() => this.records.threads(), []))
      this.threads.set(thread.id, thread)
    for (const message of this.read(() => this.records.messages(), [])) {
      this.messages.set(message.id, message)
      if (message.response) this.responses.set(message.response.askId, message.id)
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

  /**
   * Stops its timers and changes no message from then on, nor leases one: leases left, and
   * every message waiting, wait again with the next runner, for their sessions resumed there.
   */
  close(): void {
    this.closed = true
    clearInterval(this.sweeper)
    clearTimeout(this.restoring)
    this.leases.clear()
  }

  /**
   * A terminal starts, or starts again, with the handle its record keeps, and the handle of
   * the terminal that leads it (`ledBy`), if one does. It sees, and is seen by, the
   * terminals of its project and Novadeck session.
   */
  register(terminalId: string, scope: Scope, handle: string, ledBy: string | null): void {
    if (this.live.has(terminalId)) return
    this.live.set(terminalId, {
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
      keyedAt: 0,
      waits: null,
      waitsSince: null,
      unconfirmed: [],
      viaScreen: false,
    })
  }

  /**
   * The terminal's lead ends, as its agent exits: messages sent after are a peer's. Its
   * lead's brief still waiting for the terminal's first session (queued or held, bound to
   * none) is gone, and its sender told, as no session it was for will bind; what already
   * belongs to a session stays, with the authority it had when sent.
   */
  endLead(terminalId: string): void {
    const live = this.live.get(terminalId)
    if (!live) return
    live.ledBy = null
    for (const message of this.messages.values())
      if (
        message.to.terminalId === terminalId &&
        message.to.sessionId === null &&
        message.fromLead &&
        (message.state === "queued" || message.state === "held")
      )
        this.gone(message)
  }

  /**
   * The handle of the running terminal that leads the terminal, if there is one: the one
   * its `ledBy` names, still running in its project and session.
   */
  leadOf(terminalId: string): string | undefined {
    const live = this.live.get(terminalId)
    return live && this.scoped(live).find((peer) => this.leads(live, peer))?.handle
  }

  /** Whether `lead` is the running lead of `worker`. */
  private leads(worker: Live, lead: Live): boolean {
    return (
      worker.ledBy !== null &&
      worker.ledBy === lead.handle &&
      worker.projectId === lead.projectId &&
      worker.sessionId === lead.sessionId
    )
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

  /** The exact agent session that an Inbox ask and its answer belong to. */
  inboxOwner(terminalId: string):
    | {
        projectId: string
        workspaceSessionId: string
        terminalId: string
        handle: string
        agent: AgentName
        sessionId: string
      }
    | undefined {
    const live = this.live.get(terminalId)
    if (!live?.root || this.closed) return undefined
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
    const owner = this.inboxOwner(terminalId)
    if (!owner) throw new DomainError("CONFLICT", "The asking agent's session has ended.")
    const message: Message = {
      id: this.freshMessageId(),
      projectId: owner.projectId,
      thread: `t-${askId.replaceAll("-", "")}`,
      hop: 2,
      from: { terminalId: "you", handle: "you", agent: null, sessionId: null },
      to: { terminalId, handle: owner.handle, agent: owner.agent, sessionId: owner.sessionId },
      text: cleanText(text),
      sentAt: this.now(),
      state: "queued",
      deliveredAt: null,
      notified: true,
      stopped: false,
      fromLead: false,
      toLead: false,
      response: { askId, subject, ...choice },
    }
    const size = deliveredBytes(message)
    if (message.text.length > 4096 || size > maxDeliveryBytes)
      throw new DomainError("ANSWER_FAILED", "That reply is too long. Shorten it and try again.")
    if (
      [...this.messages.values()].filter(
        (each) =>
          each.response !== undefined && each.to.terminalId === terminalId && undelivered(each),
      ).length >= maxUndelivered
    )
      throw new DomainError(
        "RESOURCE_LIMIT",
        "This agent already has 50 person replies waiting. Try again once they arrive.",
      )
    commit(message)
    this.messages.set(message.id, message)
    this.responses.set(askId, message.id)
    this.changed(terminalId)
  }

  /** The reply for one Inbox ask, used to retain pending replies with their question. */
  inboxReply(askId: string): Message | undefined {
    const id = this.responses.get(askId)
    return id ? this.messages.get(id) : undefined
  }

  /** Drops only resolved person replies whose questions have left retained history. */
  forgetResponses(ids: readonly string[]): void {
    const messages = ids.flatMap((id) => {
      const message = this.inboxReply(id)
      return message && !undelivered(message) ? [message] : []
    })
    if (!messages.length) return
    this.records.removeMessages(messages.map((message) => message.id))
    for (const message of messages) {
      this.messages.delete(message.id)
      this.holdsTold.delete(message.id)
      this.responses.delete(message.response!.askId)
      this.changed(message.to.terminalId)
    }
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

  /**
   * The agent's own prompt shows in the terminal before any session of its has bound
   * there, as Codex's title or Antigravity's status line tells it: it is Ready, and
   * messages wait for the first session of that agent to bind there, or for the session
   * whose id starts with `prefix`. With a root session bound it changes nothing, unless it
   * `replaces` that session (the terminal manager then ends its binding), as Codex's
   * /clear starts a thread that binds only with its first prompt, judged `at` when it
   * showed.
   */
  shown(
    terminalId: string,
    agent: AgentName,
    prefix: string | null,
    replaces = false,
    at = this.now(),
    firedAt?: number,
  ): void {
    const live = this.live.get(terminalId)
    if (!live || (live.root && !replaces)) return
    const learned = live.shown?.agent !== agent || live.shown.prefix !== prefix
    live.shown = { agent, prefix }
    live.untrusted = null
    this.step(live, { type: "shown", at, replaces, ...(firedAt !== undefined && { firedAt }) })
    // A prefix it learns later may make other messages its own.
    if (learned) this.changed(terminalId)
  }

  /**
   * The person's Escape that may have cancelled the root turn, as delivery took it, as an
   * event for the bound session's activity, so both tell the same (see `turn-escaped`).
   * Each Escape is told once, as it ends the turn: a turn that went on after it, asking
   * the person something, keeps what it asked.
   */
  escaped(terminalId: string, binding: Binding): ActivityEvent | undefined {
    const live = this.live.get(terminalId)
    if (!live) return undefined
    const { delivery } = live
    if (delivery.state !== "unknown" || delivery.escapedAt === undefined) return undefined
    if (live.escapeTold === delivery.escapedAt) return undefined
    live.escapeTold = delivery.escapedAt
    const { agent, sessionId, instance } = binding
    return { type: "turn-escaped", agent, sessionId, instance, startedAt: delivery.escapedAt }
  }

  /** The agent whose hooks were found untrusted there, with no session bound, if any. */
  untrustedAgent(terminalId: string): AgentName | undefined {
    return this.live.get(terminalId)?.untrusted ?? undefined
  }

  /** The agent whose prompt shows there with no session bound, if any. */
  shownAgent(terminalId: string): AgentName | undefined {
    const live = this.live.get(terminalId)
    return live && !live.root ? live.shown?.agent : undefined
  }

  /**
   * The agent's own prompt shows in the terminal with no session bound, but Novadeck's
   * hooks aren't trusted for it there, as Codex's app-server says: until its prompt counts,
   * a session binds or it leaves, `send` refuses it, as nothing could deliver.
   */
  untrusted(terminalId: string, agent: AgentName): void {
    const live = this.live.get(terminalId)
    if (!live || live.root || live.untrusted === agent) return
    live.untrusted = agent
    this.changed(terminalId)
  }

  /** The agent whose prompt showed left before any session bound, as the shell's prompt says. */
  unshown(terminalId: string): void {
    const live = this.live.get(terminalId)
    if (live) live.untrusted = null
    if (!live?.shown) return
    live.shown = null
    if (!live.root && live.delivery.state !== "unbound") this.step(live, { type: "unbound" })
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
   * What a Stop, prompt-time or tool-call hook prints, as it asks once its report is
   * applied: the messages waiting for the terminal's root session, leased to it, when its
   * report is a root turn event that may take them and its `deadline` leaves time to print
   * them. A harness whose injected messages last one call gets a turn's delivery again on
   * each later call of it. At a root tool call, or a later model call of such a harness,
   * only the lead's messages are leased: what directs the worker reaches it mid-turn.
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
    const silent = { leaseId: null, stdout: silentFor(profile, report.event) }
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
    const asked = {
      live,
      root,
      profile,
      silent,
      events: report.events,
      event: report.event,
      time: report.deadline - this.now() >= leaseMargin,
    }
    if (kind === "stop") return this.askStop(asked, stop)
    return kind === "tool" ? this.askTool(asked) : this.askPrompt(asked)
  }

  /**
   * A root Stop: the turn continues with the messages waiting, when it may, else ends. A
   * report with no root Stop of the session says nothing.
   */
  private askStop(
    { live, root, profile, silent, time }: Asked,
    stop: Extract<HarnessEvent, { type: "turn-ended" }> | undefined,
  ): HookAnswer {
    if (!stop) return silent
    const background = runsOn(stop.background)
    const lease =
      time &&
      continues(live.delivery) &&
      this.lease(live, root, { kind: "stop", background, print: profile.stop })
    this.step(live, {
      type: "stop",
      continued: Boolean(lease),
      background,
      at: this.now(),
      startedAt: stop.startedAt,
    })
    return lease ? { leaseId: lease.id, stdout: profile.stop(lease.text) } : silent
  }

  /**
   * A root turn's start, or a later model call of it: what waits goes with the prompt. A
   * harness whose injected messages last one call also gets the turn's delivery again, with
   * the lead's messages that came since joined to it.
   */
  private askPrompt({ live, root, profile, silent, events, time }: Asked): HookAnswer {
    const start = events.find(
      (event): event is Extract<HarnessEvent, { type: "turn-started" }> =>
        event.type === "turn-started" && rootedIn(root, event),
    )
    if (!start) return silent
    // A later model call of the turn sees again what its first was given.
    const kept = profile.reinjectPerCall
      ? this.leases.recall(live.terminalId, live.delivery.epoch)
      : undefined
    // What this terminal sent that waits long goes with whatever the hook prints, once.
    const holds = time ? this.heldFrom(live.terminalId) : []
    const again = kept === undefined ? undefined : profile.prompt(noted(kept, holds))
    if (start.cause === "call") {
      const print = (text: string) => profile.prompt(noted(joined(kept, text), holds))
      const added =
        time && running(live.delivery)
          ? this.lease(live, root, {
              kind: "midturn",
              print,
              only: isFromLead,
              keeps: (text) => joined(kept, text),
            })
          : undefined
      if (added) return { leaseId: added.id, stdout: print(added.text) }
      const rest = noted(kept, holds)
      return rest ? { leaseId: null, stdout: profile.prompt(rest) } : silent
    }
    const print = (text: string) => profile.prompt(noted(text, holds))
    const lease =
      time &&
      this.lease(live, root, {
        kind: "prompt",
        print,
        ...(profile.reinjectPerCall && { keeps: (text: string) => text }),
      })
    if (lease) return { leaseId: lease.id, stdout: print(lease.text) }
    if (again) return { leaseId: null, stdout: again }
    if (start.cause !== "doorbell")
      return holds.length > 0 ? { leaseId: null, stdout: print("") } : silent
    // A doorbell whose messages couldn't be leased now, as too late or while paused, says
    // they still wait; one with none left, as when they went another way, that none do.
    const waits = [...this.messages.values()].some(
      (message) =>
        message.to.terminalId === live.terminalId &&
        undelivered(message) &&
        this.addressed(message, root),
    )
    return { leaseId: null, stdout: print(waits ? stillWaiting : nothingWaiting) }
  }

  /**
   * A root tool call finished, in a turn that runs: the lead's messages waiting go beside
   * its result, as its harness reads them. A peer's wait for the turn's end.
   */
  private askTool({ live, root, profile, silent, events, event, time }: Asked): HookAnswer {
    const { call } = profile
    // Only the root agent's own call, not a failure that was an abort (the person's Esc ends
    // the turn, and a tool's cancel is no call to answer in).
    const called = events.some(
      (each) =>
        each.type === "attention-resolved" &&
        each.actor === null &&
        each.interrupted !== true &&
        rootedIn(root, each),
    )
    if (!call || !called || !time || !running(live.delivery)) return silent
    // What this terminal sent that waits long goes beside the result too, once.
    const holds = this.heldFrom(live.terminalId)
    const print = (text: string) => call(noted(text, holds), event)
    const lease = this.lease(live, root, { kind: "midturn", print, only: isFromLead })
    if (lease) return { leaseId: lease.id, stdout: print(lease.text) }
    return holds.length > 0 ? { leaseId: null, stdout: print("") } : silent
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
    if (lease.keeps !== undefined) this.leases.remember(terminalId, lease.epoch, lease.keeps)
  }

  /**
   * The person's keys to the terminal, apart from its automatic replies, while a request
   * waits on them (`asked`) or not. Delivery alone decides what they did to the box.
   */
  keys(terminalId: string, kinds: readonly KeyKind[], asked: boolean): void {
    const live = this.live.get(terminalId)
    if (!live) return
    const at = this.now()
    live.keyedAt = at
    for (const key of kinds) this.step(live, { type: "key", key, asked, at })
  }

  /**
   * The terminal's screen shows its agent's own box empty and calm, read from `readAt` on, in
   * the `epoch` it was read in, where its delivery is Drafting, Unknown or Fresh: Settled
   * again where a turn completed (`completedAt`), else Ready.
   * Not after a key of the person's since the read, whose text it may not have shown.
   */
  emptied(terminalId: string, epoch: number, readAt = this.now()): void {
    const live = this.live.get(terminalId)
    if (!live || live.keyedAt >= readAt) return
    this.step(live, { type: "emptied", at: this.now(), epoch })
  }

  /**
   * Whether the terminal's agent is idle but not ringable by its state alone (Fresh,
   * Drafting or Unknown), with messages waiting for it: the doorbell looks at its screen
   * for an empty box, and for a prompt the harness shows queued.
   */
  stalled(terminalId: string): boolean {
    const live = this.live.get(terminalId)
    if (!live) return false
    const { delivery } = live
    if (!waitsIn(delivery) || queueBarLeft(delivery, this.now(), this.slackMs) > 0) return false
    return this.waiting(live)
  }

  /**
   * How long the terminal's screen is not believed yet, after a Stop that left the person's
   * prompt queued for the harness to submit; 0 when no bar stands.
   */
  queueBar(terminalId: string): number {
    const delivery = this.live.get(terminalId)?.delivery
    return delivery ? queueBarLeft(delivery, this.now(), this.slackMs) : 0
  }

  /** Why the doorbell can't ring the terminal, as its screen shows; null once it can. */
  blocked(terminalId: string, waits: Waits | null): void {
    const live = this.live.get(terminalId)
    if (!live || live.waits === waits) return
    this.waits(live, waits)
    this.changed(terminalId)
  }

  /** Says why the doorbell can't ring, keeping since when it can't through a change of why. */
  private waits(live: Live, waits: Waits | null): void {
    live.waits = waits
    live.waitsSince = waits === null ? null : (live.waitsSince ?? this.now())
  }

  /** Since when the messages for the terminal have been held, the longest; null if none is. */
  private oldestHeld(live: Live): number | null {
    let oldest: number | null = null
    for (const message of this.messages.values()) {
      if (message.to.terminalId !== live.terminalId) continue
      const since = this.heldSince(live, message)
      if (since !== undefined && (oldest === null || since < oldest)) oldest = since
    }
    return oldest
  }

  /** Why the doorbell can't ring the terminal's idle agent, as its listing says; null if not. */
  private waitsOf(live: Live): Waits | null {
    return waitsIn(live.delivery) || ringableSince(live.delivery) !== undefined ? live.waits : null
  }

  /**
   * Since when a message for the terminal has been held behind what keeps its doorbell from
   * it: the later of its sending and the hold's start; undefined while nothing holds it.
   */
  private heldSince(live: Live, message: Message): number | undefined {
    return this.waitsOf(live) && live.waitsSince !== null && message.state === "queued"
      ? Math.max(live.waitsSince, message.sentAt)
      : undefined
  }

  /**
   * The caller's messages held at least `longHoldMs` behind what keeps their recipient's
   * doorbell from it, as words: told now, once for each hold.
   */
  heldFrom(terminalId: string): readonly string[] {
    const now = this.now()
    const held = new Map<string, { live: Live; waits: Waits; since: number; ids: string[] }>()
    for (const message of this.messages.values()) {
      if (message.from.terminalId !== terminalId) continue
      const to = this.live.get(message.to.terminalId)
      const since = to && this.heldSince(to, message)
      const waits = to && this.waitsOf(to)
      if (!to || !waits || since === undefined || now - since < longHoldMs) continue
      if (this.holdsTold.get(message.id) === since) continue
      this.holdsTold.set(message.id, since)
      const each = held.get(to.terminalId) ?? { live: to, waits, since, ids: [] }
      each.since = Math.min(each.since, since)
      each.ids.push(message.id)
      held.set(to.terminalId, each)
    }
    return [...held.values()].map(({ live, waits, since, ids }) =>
      holdNotice(ids, live.handle, waits, since),
    )
  }

  /** No request waits on the person any more: what they typed meanwhile counts now. */
  askedCleared(terminalId: string): void {
    const live = this.live.get(terminalId)
    if (live) this.step(live, { type: "asked-cleared" })
  }

  /**
   * Whether the doorbell may ring the terminal: Settled, or Ready (a new session at its
   * own prompt), with messages waiting for its root session. The doorbell waits for the
   * screen to settle, and checks it, before it rings.
   */
  ringable(terminalId: string): boolean {
    const live = this.live.get(terminalId)
    return live !== undefined && ringableSince(live.delivery) !== undefined && this.waiting(live)
  }

  /** Whether messages wait for the terminal's root session (or the one about to bind). */
  private waiting(live: Live): boolean {
    const { root, terminalId } = live
    for (const message of this.messages.values())
      if (
        message.state === "queued" &&
        message.to.terminalId === terminalId &&
        (root ? this.addressed(message, root) : this.awaiting(live, message))
      )
        return true
    return false
  }

  /**
   * The text of the person's prompt that started the root turn running in the terminal,
   * as its hooks or transcript told it; undefined unless that turn is the person's own
   * submission (never one the doorbell or the harness started).
   */
  personPrompt(terminalId: string): string | undefined {
    const live = this.live.get(terminalId)
    if (!live) return undefined
    const { delivery, prompt } = live
    if (!running(delivery) || !delivery.byPerson || prompt?.epoch !== delivery.epoch)
      return undefined
    return prompt.text
  }

  /**
   * When the terminal last became Settled, its turn ended, or Ready, its session bound; if
   * it is either.
   */
  settledSince(terminalId: string): number | undefined {
    const delivery = this.live.get(terminalId)?.delivery
    return delivery && ringableSince(delivery)
  }

  /**
   * Whether the terminal is Ready at a new session's own prompt, with no turn yet: not one
   * made Ready by its screen, which has had turns.
   */
  ready(terminalId: string): boolean {
    const live = this.live.get(terminalId)
    return live?.delivery.state === "ready" && !live.viaScreen
  }

  /** Whether the terminal is idle by its screen's word alone, not a Stop's or a session start's. */
  byScreen(terminalId: string): boolean {
    return this.live.get(terminalId)?.viaScreen === true
  }

  /**
   * A mark that changes with each root turn event (a delivery epoch) and each key
   * of the person's.
   */
  stamp(terminalId: string): string {
    const live = this.live.get(terminalId)
    return live ? `${live.delivery.epoch}:${live.keyedAt}` : ""
  }

  /** Whether the terminal is Settled or Ready with messages waiting for its agent. */
  idleWaiting(terminalId: string): boolean {
    const live = this.live.get(terminalId)
    return live !== undefined && ringableSince(live.delivery) !== undefined && this.waiting(live)
  }

  /**
   * When the person's bare Enter came, if a root turn whose hook started at `startedAt`,
   * its shell at `firedAt` where told, would be their submission: within the window,
   * before anything they typed after it.
   */
  pendingSubmission(terminalId: string, startedAt: number, firedAt?: number): number | undefined {
    const delivery = this.live.get(terminalId)?.delivery
    if (!delivery) return undefined
    const fired = firing({ at: startedAt, ...(firedAt !== undefined && { firedAt }) }, this.slackMs)
    return pendingEnter(delivery, fired.at, fired.windowMs)
  }

  /** The doorbell starts ringing the terminal with its nonce; false when it may not now. */
  ring(terminalId: string, nonce: string): boolean {
    const live = this.live.get(terminalId)
    if (!live || !this.ringable(terminalId)) return false
    this.step(live, { type: "ring", nonce, opening: !live.root })
    if (live.delivery.state !== "ringing") return false
    live.unconfirmed = [...live.unconfirmed.filter((each) => each !== nonce), nonce].slice(
      -maxUnconfirmed,
    )
    return true
  }

  /** Whether `nonce` is one of the terminal's rings that no doorbell prompt confirmed. */
  unconfirmed(terminalId: string, nonce: string): boolean {
    return this.live.get(terminalId)?.unconfirmed.includes(nonce) === true
  }

  /**
   * The doorbell submits the doorbell line its screen shows alone in the box, as a ring that
   * failed or was abandoned left it, rung again under that line's own `nonce`: the terminal
   * is Ringing; false when it may not now.
   */
  ringLeftover(terminalId: string, nonce: string): boolean {
    const live = this.live.get(terminalId)
    if (!live || !this.stalled(terminalId) || !live.unconfirmed.includes(nonce)) return false
    this.step(live, { type: "ring", nonce, opening: !live.root, leftover: true })
    return live.delivery.state === "ringing"
  }

  /** The nonce of the ring under way in the terminal, if it is Ringing. */
  ringing(terminalId: string): string | undefined {
    const delivery = this.live.get(terminalId)?.delivery
    return delivery?.state === "ringing" ? delivery.nonce : undefined
  }

  /** The ring with that nonce failed: the terminal is Unknown, and its messages wait. */
  ringFailed(terminalId: string, nonce: string): void {
    const live = this.live.get(terminalId)
    if (live) this.step(live, { type: "ring-failed", nonce })
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
   * The other running terminal in the caller's project and session whose exact handle
   * `to` is, as `send` finds its recipient, with the agent running there as `agents`
   * names it; or why there is none, describing every terminal there as `send` does.
   */
  peer(terminalId: string, to: string, about: About = () => undefined): PeerAnswer {
    const live = this.live.get(terminalId)
    if (!live) return refused("Novadeck couldn't find the terminals here.")
    const found = this.scoped(live).find((peer) => peer.handle === to)
    if (found)
      return {
        ok: true,
        terminalId: found.terminalId,
        handle: found.handle,
        agent: found.root?.agent ?? found.shown?.agent ?? null,
      }
    return refused(
      unknownHandle(
        to,
        live.handle,
        this.peers(live, about),
        this.now(),
        this.leadOf(live.terminalId) ?? null,
      ),
    )
  }

  /**
   * How many messages terminals other than `except` sent `terminalId` that are yet to
   * arrive, which closing it makes gone.
   */
  waitingFor(terminalId: string, except: string): number {
    return [...this.messages.values()].filter(
      (message) =>
        message.to.terminalId === terminalId &&
        message.from.terminalId !== except &&
        undelivered(message),
    ).length
  }

  /** The caller's messages gone since it was last told, told now, as every answer tells them. */
  goneFrom(
    terminalId: string,
  ): readonly { readonly id: string; readonly to: string; readonly stopped?: true }[] {
    const gone = [...this.messages.values()].filter(
      (message) =>
        message.from.terminalId === terminalId && message.state === "gone" && !message.notified,
    )
    for (const message of gone) this.put({ ...message, notified: true })
    return gone.map((message) => ({
      id: message.id,
      to: message.to.handle,
      ...(message.stopped && { stopped: true as const }),
    }))
  }

  /**
   * An agent's message to another terminal in its project and session, by that
   * terminal's exact handle. It never claims delivery: it answers where the message is,
   * or why not, describing every terminal there when `to` is no current handle.
   */
  send(terminalId: string, request: unknown, about: About = () => undefined): SendAnswer {
    const live = this.live.get(terminalId)
    if (!live) return refused("Novadeck couldn't send the message.")
    if (this.closed) return refused(stopping)
    const answer = this.sendFrom(live, request, about)
    // Refused too, a sender whose own session never bound learns replies can't reach it.
    return answer.ok || !this.unbound(live) ? answer : { ...answer, unbound: true }
  }

  private sendFrom(live: Live, request: unknown, about: About): SendAnswer {
    const { terminalId } = live
    const parsed = sendRequest.safeParse(request)
    if (!parsed.success)
      return refused("A message needs `to`, a terminal's handle, and its `text`.")
    const text = cleanText(parsed.data.text)
    const textRefusal = refusalOfText(text)
    if (textRefusal) return refused(textRefusal)
    const recipient = this.scoped(live).find((peer) => peer.handle === parsed.data.to)
    if (!recipient)
      return refused(
        unknownHandle(
          parsed.data.to,
          live.handle,
          this.peers(live, about),
          this.now(),
          this.leadOf(live.terminalId) ?? null,
        ),
      )
    const root = recipient.root
    if (!root && !recipient.shown && recipient.untrusted)
      return refused(
        `${mention(recipient.handle)} has no agent Novadeck can deliver to: ` +
          `${untrustedNote(recipient.untrusted)}.`,
      )
    const agent = root?.agent ?? recipient.shown?.agent ?? recipient.expecting
    if (!agent)
      return refused(
        `${mention(recipient.handle)} has no agent running there that Novadeck can deliver to.`,
      )
    const now = this.now()
    const known = threadBetween(this.threads.values(), terminalId, recipient.terminalId, now)
    // The person stopped it: nothing continues it, and the refusal leaves its clock alone.
    if (stoppedBetween(this.threads.values(), terminalId, recipient.terminalId, now))
      return refused(
        `The user stopped your thread with ${mention(recipient.handle)} in Novadeck. ` +
          `Don't message ${mention(recipient.handle)} about it again unless the user asks.`,
      )
    const same = duplicateOf(this.messages.values(), terminalId, recipient.terminalId, text, now)
    if (same) return { ...this.answer(same, recipient), ...this.extras(live) }
    const thread: Thread = known
      ? { ...known, hops: known.hops + 1, lastAt: now }
      : {
          id: this.freshThreadId(),
          projectId: live.projectId,
          between: [terminalId, recipient.terminalId],
          hops: 1,
          allowed: hopsPerRelease,
          lastAt: now,
          stoppedAt: null,
        }
    // Its authority is fixed now: from the recipient's running lead, it is marked so when
    // delivered, and never awaits release, whatever happens to the lead after.
    const fromLead = this.leads(recipient, live)
    const toLead = this.leads(live, recipient)
    const message: Message = {
      ...this.draft(live, text, {
        terminalId: recipient.terminalId,
        handle: recipient.handle,
        agent,
      }),
      id: this.freshMessageId(),
      thread: thread.id,
      hop: thread.hops,
      to: {
        terminalId: recipient.terminalId,
        handle: recipient.handle,
        agent,
        sessionId: root?.sessionId ?? null,
      },
      fromLead,
      toLead,
      state: waiting({ hop: thread.hops, fromLead, toLead }, thread, this.paused),
    }
    const vetted = this.vet(message)
    if (!vetted.ok) return vetted
    const { bySender, byPair, byAll, pair } = vetted
    this.sent.set(terminalId, bySender)
    this.pairs.set(pair, byPair)
    this.allSent = byAll
    this.putThread(thread)
    this.put(message)
    return { ...this.answer(message, recipient), ...this.extras(live) }
  }

  /**
   * Why `send` would refuse the caller's message to a terminal not yet open, running
   * `agent`, as its task: every check `send` makes but the recipient's own; undefined
   * when it would take it.
   */
  refusal(terminalId: string, text: string, agent: AgentName): string | undefined {
    const live = this.live.get(terminalId)
    if (!live) return "Novadeck couldn't send the message."
    if (this.closed) return stopping
    const clean = cleanText(text)
    const textRefusal = refusalOfText(clean)
    if (textRefusal) return textRefusal
    // The longest handle a terminal may have, so the size is never underestimated.
    const vetted = this.vet(
      this.draft(live, clean, {
        terminalId: "",
        handle: "z".repeat(12) + "999999999",
        agent,
      }),
    )
    return vetted.ok ? undefined : vetted.reason
  }

  /** A message from the caller to a recipient, as it would be sent now, for `vet`. */
  private draft(
    live: Live,
    text: string,
    to: { readonly terminalId: string; readonly handle: string; readonly agent: AgentName },
  ): Message {
    return {
      id: "m-0000000000",
      projectId: live.projectId,
      thread: "t-0000000000",
      hop: hopsPerRelease,
      from: {
        terminalId: live.terminalId,
        handle: live.handle,
        agent: live.root?.agent ?? null,
        sessionId: live.root?.sessionId ?? null,
      },
      to: { ...to, sessionId: null },
      text,
      sentAt: this.now(),
      state: "queued",
      deliveredAt: null,
      notified: false,
      stopped: false,
      fromLead: false,
      toLead: false,
    }
  }

  /**
   * What `send` checks of a message beyond its text, as it would be sent: its size once
   * delivered, the recipient's undelivered cap, and the rates, with the send times it
   * would spend. One check for every way a message is sent, so they never drift apart.
   */
  private vet(message: Message):
    | { readonly ok: false; readonly reason: string }
    | {
        readonly ok: true
        readonly pair: string
        readonly bySender: readonly number[]
        readonly byPair: readonly number[]
        readonly byAll: readonly number[]
      } {
    // Alone in a delivery, it must fit whichever harness it reaches, as it is printed.
    const size = deliveredBytes(message)
    if (size > maxDeliveryBytes)
      return refused(
        `Delivered, this message would take ${size} bytes, over the ${maxDeliveryBytes} a ` +
          'delivery may: plain text of up to 4 KB fits, but characters such as < > & " and ' +
          "line breaks take more room once escaped. Shorten it, or put it in a file and send " +
          "its path.",
      )
    const { to, from } = message
    const waitingThere = [...this.messages.values()].filter(
      (each) => !each.response && each.to.terminalId === to.terminalId && undelivered(each),
    ).length
    if (waitingThere >= maxUndelivered)
      return refused(
        `${mention(to.handle)} already has ${maxUndelivered} messages waiting; ` +
          "wait for it to take them before sending more.",
      )
    const now = message.sentAt
    const pair = `${from.terminalId}\0${to.terminalId}`
    const bySender = allowSend(this.sent.get(from.terminalId) ?? [], now, rates.sender)
    const byPair = allowSend(this.pairs.get(pair) ?? [], now, rates.pair)
    const byAll = allowSend(this.allSent, now, rates.all)
    if (!bySender || !byPair)
      return refused(
        `An agent may send ${rates.sender} messages a minute, ${rates.pair} of them to any ` +
          "one terminal; try again shortly.",
      )
    if (!byAll)
      return refused(
        "Agents in Novadeck have sent as many messages as they may this minute; try again shortly.",
      )
    return { ok: true, pair, bySender, byPair, byAll }
  }

  /**
   * The other terminals in the caller's project and session, each described by what
   * Novadeck knows of it, and the caller's own messages not yet delivered or gone, as one
   * text agents read.
   */
  agents(terminalId: string, about: About = () => undefined): AgentsAnswer {
    const live = this.live.get(terminalId)
    if (!live) return refused("Novadeck couldn't list the terminals.")
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
      lead: this.leadOf(live.terminalId) ?? null,
      peers: this.peers(live, about),
      messages: mine.map((message) => ({ message, hold: this.holdOf(message) })),
      unbound: live.root === null,
      now: this.now(),
    })
    // As every answer to the caller does, it tells of its messages held long, once.
    const holds = this.heldFrom(terminalId)
    return { ok: true, text: [text, ...holds].join("\n") }
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
        stopped: thread !== undefined && stopBlocks(thread, this.now()),
        messages: messages.slice(-1000).map((message) => ({
          id: message.id,
          thread: message.thread,
          hop: message.hop,
          from: message.from.handle,
          fromAgent: message.from.agent,
          to: message.to.handle,
          toAgent: message.to.agent,
          text: message.response
            ? [message.response.option ?? message.response.action, message.text]
                .filter(Boolean)
                .join("\n\n")
            : message.text,
          sentAt: message.sentAt,
          state: message.state,
          held: message.state === "held" ? this.holdOf(message) : null,
          deliveredAt: message.deliveredAt,
          ...(message.response && { inbox: "answer" as const }),
        })),
      }
    })
    return {
      terminalId,
      handle,
      delivery: live?.delivery.state ?? "unbound",
      waits: live ? this.waitsOf(live) : null,
      waitsSince: live ? this.oldestHeld(live) : null,
      paused: this.paused,
      threads: threads.toSorted((a, b) => latest(b) - latest(a)).slice(0, 1000),
    }
  }

  /**
   * Hears of every change to a terminal's messages, threads or delivery state, and of the
   * pause, as the doorbell and each watch of a terminal's messages do, until the returned
   * function is called.
   */
  subscribe(listener: (change: MessagingChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Whether messaging is paused, across the whole runner. */
  isPaused(): boolean {
    return this.paused
  }

  /**
   * Pauses messaging across the whole runner, or resumes it, keeping the switch: waiting
   * agent messages are held while paused, and wait in order again once resumed. Person
   * replies are unaffected, including after a restart or lost delivery lease.
   */
  pause(paused: boolean): void {
    this.write(() => this.records.pauseMessaging(paused))
    const changed = this.paused !== paused
    this.paused = paused
    for (const message of this.messages.values())
      if (message.state === "queued" || message.state === "held") this.wait(message)
    if (changed) this.emit({ kind: "pause", paused })
  }

  /**
   * Releases a thread: its held messages wait to be delivered, and it may have 12 more. A
   * stopped one is no longer stopped, but its messages that went stay gone.
   */
  release(threadId: string): void {
    const thread = this.threads.get(threadId)
    if (!thread) throw new DomainError("NOT_FOUND")
    this.putThread({ ...thread, allowed: thread.hops + hopsPerRelease, stoppedAt: null })
    const terminals = new Set<string>()
    for (const message of this.messages.values()) {
      if (message.thread !== threadId) continue
      terminals.add(message.from.terminalId).add(message.to.terminalId)
      if (message.state === "held") this.wait(message)
    }
    // Its hops allowed changed, whether or not any message waited.
    for (const terminalId of terminals) this.changed(terminalId)
  }

  /**
   * Stops a thread: its messages still queued or held are gone, their senders told the
   * person stopped it; one a lease holds is left to finish. A message that would continue
   * it is refused until it lapses (`threadMs`) or the person releases it. Stopping a
   * stopped thread does nothing.
   */
  stop(threadId: string): void {
    const thread = this.threads.get(threadId)
    if (!thread) throw new DomainError("NOT_FOUND")
    if (stopBlocks(thread, this.now())) return
    this.putThread({ ...thread, stoppedAt: this.now() })
    const terminals = new Set<string>()
    for (const message of this.messages.values()) {
      if (message.thread !== threadId) continue
      terminals.add(message.from.terminalId).add(message.to.terminalId)
      if (message.state === "queued" || message.state === "held")
        this.put({ ...message, state: "gone", notified: false, stopped: true })
    }
    for (const terminalId of terminals) this.changed(terminalId)
  }

  /**
   * Forgets a removed project's messages and threads, once its terminals are gone. The
   * records keep them until the project's own are deleted, with them.
   */
  forgetProject(projectId: string): void {
    for (const [id, message] of this.messages)
      if (message.projectId === projectId) {
        this.messages.delete(id)
        this.holdsTold.delete(id)
        if (message.response) this.responses.delete(message.response.askId)
      }
    for (const [id, thread] of this.threads)
      if (thread.projectId === projectId) this.threads.delete(id)
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
        now - Math.max(message.sentAt, message.deliveredAt ?? 0, message.response?.goneAt ?? 0) >=
          retentionMs,
    )
    for (const { id, response } of old) {
      this.messages.delete(id)
      this.holdsTold.delete(id)
      if (response) this.responses.delete(response.askId)
    }
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
      // The session the agent showing its prompt there is about to bind.
      if (live && !live.root && this.awaiting(live, message)) continue
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
        agent: peer.root?.agent ?? peer.shown?.agent ?? null,
        expecting: peer.root || peer.shown ? null : peer.expecting,
        untrusted: peer.root || peer.shown ? null : peer.untrusted,
        // Working as its terminal shows it too: waiting on subagents its turn left
        // running, as after an Esc, is no delivery phase.
        busy: peer.delivery.state === "working" || about(peer.terminalId)?.working === true,
        where: about(peer.terminalId),
        withYou: lastBetween(this.messages.values(), live.terminalId, peer),
        lead: this.leadOf(peer.terminalId) ?? null,
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
    const agent = recipient.root?.agent ?? recipient.shown?.agent
    const profile = agent ? harnesses[agent].messaging : undefined
    return {
      ...base,
      route: profile
        ? route(
            recipient.delivery,
            profile.silentOnFailure,
            isFromLead(message)
              ? midTurnCall(profile.call !== undefined, profile.reinjectPerCall)
              : undefined,
            recipient.waits ?? undefined,
          )
        : "when its agent starts: rung once Novadeck sees it at its prompt, else at its first turn",
    }
  }

  /**
   * What every answer to the sender adds: its messages newly gone, or held long, and whether
   * replies reach it.
   */
  private extras(live: Live) {
    const gone = this.goneFrom(live.terminalId)
    const holds = this.heldFrom(live.terminalId)
    return {
      ...(gone.length > 0 && { gone }),
      ...(holds.length > 0 && { holds }),
      ...(this.unbound(live) && { unbound: true as const }),
    }
  }

  /** Whether the terminal's own session never bound, so replies can't reach it. */
  private unbound(live: Live): boolean {
    return live.root === null && !live.shown
  }

  private holdOf(message: Message): "paused" | "release" | null {
    return message.response ? null : holdOf(message, this.threads.get(message.thread), this.paused)
  }

  /** Puts an undelivered message back to waiting: held for a reason, else queued. */
  private wait(message: Message): void {
    // A stopped thread's message never waits again: one a lease held is gone with it.
    if (message.stopped) return
    const thread = this.threads.get(message.thread)
    if (thread?.stoppedAt != null && undelivered(message)) {
      this.put({ ...message, state: "gone", notified: false, stopped: true })
      return
    }
    const state = message.response ? "queued" : waiting(message, thread, this.paused)
    if (state !== message.state) this.put({ ...message, state })
  }

  private gone(message: Message): void {
    const response =
      message.response && message.state !== "gone" && message.deliveredAt === null
        ? { ...message.response, goneAt: this.now() }
        : message.response
    this.put({ ...message, state: "gone", notified: false, ...(response && { response }) })
  }

  /**
   * Leases the messages waiting for the root session (those `only` takes, where it is
   * given), as many as one delivery carries once `print` prints it as its harness reads it,
   * until the hook acknowledges them; none when none wait. `keeps` is what the turn is given
   * again on each later call once printed, where its harness's injected messages last one.
   */
  private lease(
    live: Live,
    root: Root,
    options: {
      readonly kind: Lease["kind"]
      readonly background?: boolean
      readonly print: (text: string) => string
      readonly only?: (message: Message) => boolean
      readonly keeps?: (text: string) => string
    },
  ): Lease | undefined {
    // Once closed, nothing is saved, so no ack could record a delivery: the next runner
    // would deliver again what a hook printed now. Its messages wait for that runner.
    if (this.closed) return undefined
    const { kind, background = false, print, only = () => true, keeps } = options
    const queued = [...this.messages.values()]
      .filter(({ state, ...message }) => state === "queued" && this.addressed(message, root))
      .filter((message) => message.to.terminalId === live.terminalId && only(message))
      .toSorted((a, b) => a.sentAt - b.sentAt)
    if (queued.length === 0) return undefined
    // One mark for the delivery, which marks its lead's messages. What counts is the bytes
    // printed, escaped as the harness reads them.
    const mark = newMark()
    const prints = (taken: readonly Message[]) => byteLength(print(wrap(taken, isFromLead, mark)))
    const messages = deliveryOf(queued, (taken) => prints(taken) <= maxDeliveryBytes)
    // The first always goes, as it fits alone; beside what the turn holds it may not.
    if (messages.length === 0 || prints(messages) > maxDeliveryBytes) return undefined
    for (const message of messages) this.put({ ...message, state: "leased" })
    const text = wrap(messages, isFromLead, mark)
    return this.leases.grant({
      terminalId: live.terminalId,
      messages: messages.map((message) => message.id),
      kind,
      epoch: live.delivery.epoch,
      background,
      text,
      ...(keeps && { keeps: keeps(text) }),
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
    if (delivery.epoch === lease.epoch && phaseOf(delivery) === "continuing") {
      live.lapsed = true
      this.step(live, {
        type: "stop",
        continued: false,
        background: lease.background,
        at: this.now(),
      })
    }
  }

  /**
   * Whether a Stop Novadeck continued lapsed since this was last asked, as an event for
   * the bound session's activity, so both tell the turn ended there. Told once.
   */
  lapsed(terminalId: string, binding: Binding, turnAt: number): ActivityEvent | undefined {
    const live = this.live.get(terminalId)
    if (!live?.lapsed) return undefined
    live.lapsed = false
    const { agent, sessionId, instance } = binding
    return { type: "turn-lapsed", agent, sessionId, instance, startedAt: turnAt }
  }

  /** Applies the root's changes to the terminal's messages and delivery, in order. */
  private applyRoot(live: Live, changes: readonly RootChange[]): void {
    for (const change of changes) {
      if (change.type === "ended") {
        if (!live.root) continue
        live.root = null
        // A session already shown at its prompt in its place keeps the state it gave.
        if (!live.shown) this.step(live, { type: "unbound" })
        // Messages for the session that ended are gone; those for the first session the
        // terminal expects wait on, until it closes.
        for (const message of this.messages.values())
          if (
            message.to.terminalId === live.terminalId &&
            message.to.sessionId !== null &&
            undelivered(message)
          )
            this.gone(message)
      } else if (change.type === "new")
        this.rootAt(live, change.root, change.guess, change.ready, change.startedAt, change.firedAt)
      else this.correct(live, change.from, change.root, change.confirmed)
    }
  }

  /**
   * A new root session in the terminal: its messages that were gone wait again, and those
   * waiting for the terminal's first session of that agent are now its own, while another
   * agent's are gone. Unless the root is only a guess, messages for any other session
   * there are gone, as after a runner restart. A session its harness announced at its own
   * prompt is `ready` to be rung.
   */
  private rootAt(
    live: Live,
    root: Root,
    guess: boolean,
    ready: boolean,
    startedAt = this.now(),
    firedAt?: number,
  ): void {
    live.root = root
    // Its first session came: from now on, only a bound session takes messages.
    live.expecting = null
    live.shown = null
    live.untrusted = null
    // Judged by when the hook that bound it started, not when it was heard, as a loaded
    // machine boots the hook late: the person's Enter before it may have submitted.
    this.step(live, {
      type: "bound",
      ready,
      at: startedAt,
      ...(firedAt !== undefined && { firedAt }),
    })
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

  /**
   * Whether a message waits for the session to come where the agent's prompt shows, with
   * no session bound: the first of that agent, or the one whose id starts as it showed.
   */
  private awaiting(live: Live, message: Pick<Message, "to">): boolean {
    const { shown } = live
    if (!shown || message.to.agent !== shown.agent) return false
    const { sessionId } = message.to
    return sessionId === null || (shown.prefix !== null && sessionId.startsWith(shown.prefix))
  }

  private addressed(message: Pick<Message, "to">, root: Root): boolean {
    return message.to.agent === root.agent && message.to.sessionId === root.sessionId
  }

  /** Applies a root turn event to the terminal's delivery. */
  private turn(live: Live, event: HarnessEvent): void {
    if (!rootedIn(live.root, event)) return
    switch (event.type) {
      case "turn-started": {
        const { epoch } = live.delivery
        // Whose turn it is, and what it did to the box, delivery alone decides.
        this.step(live, {
          type: "prompt",
          by: event.cause,
          ...(event.nonce !== undefined && { nonce: event.nonce }),
          at: this.now(),
          startedAt: event.startedAt,
          ...(event.firedAt !== undefined && { firedAt: event.firedAt }),
        })
        // A new root turn: the prompt that started it, if a prompt with text did.
        if (live.delivery.epoch !== epoch)
          live.prompt =
            event.cause === "prompt" && event.prompt !== undefined
              ? { epoch: live.delivery.epoch, text: event.prompt }
              : null
        return
      }
      case "turn-ended":
        if (event.outcome === "completed")
          this.step(live, {
            type: "stop",
            continued: false,
            background: runsOn(event.background),
            at: this.now(),
            ...(event.recorded && { recorded: true }),
          })
        else this.step(live, { type: "ended", ...(event.recorded && { recorded: true }) })
        return
      case "turn-idle":
        this.step(live, {
          type: "idle",
          background: runsOn(event.background),
          at: this.now(),
          startedAt: event.startedAt,
        })
        return
      case "turn-working":
        this.step(live, { type: "working", startedAt: event.startedAt })
        return
      default:
        return
    }
  }

  private step(live: Live, event: DeliveryEvent): void {
    const before = live.delivery
    // A doorbell prompt submitted its line: one in the box again is the person's.
    const confirmed = event.type === "prompt" && event.by === "doorbell" ? event.nonce : undefined
    if (confirmed !== undefined)
      live.unconfirmed = live.unconfirmed.filter((each) => each !== confirmed)
    live.delivery = transition(before, event, this.slackMs)
    if (live.delivery === before) return
    const { state } = live.delivery
    live.viaScreen =
      (event.type === "emptied" && (state === "ready" || state === "settled")) ||
      (live.viaScreen &&
        (state === "ready" || state === "settled") &&
        live.delivery.epoch === before.epoch)
    // The doorbell's last word on why it can't ring is about an idle agent only.
    if (state === "working" || state === "ringing" || state === "unbound" || live.viaScreen)
      this.waits(live, null)
    // A turn that ended, or a new one, leaves the last one's delivery behind.
    if ((running(before) && !running(live.delivery)) || live.delivery.epoch !== before.epoch)
      this.leases.forget(live.terminalId)
    this.changed(live.terminalId)
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
    if (this.closed) return
    this.messages.set(message.id, message)
    if (message.state !== "queued") this.holdsTold.delete(message.id)
    if (message.response) this.responses.set(message.response.askId, message.id)
    this.write(() => this.records.saveMessage(message))
    this.changed(message.to.terminalId)
    this.changed(message.from.terminalId)
  }

  private changed(terminalId: string): void {
    this.emit({ kind: "terminal", terminalId })
  }

  private emit(change: MessagingChange): void {
    for (const listener of this.listeners)
      try {
        listener(change)
      } catch (error) {
        // One listener failing never stops messaging, nor the others hearing.
        console.error("Novadeck could not follow its messages:", error)
      }
  }

  private putThread(thread: Thread): void {
    if (this.closed) return
    this.threads.set(thread.id, thread)
    this.write(() => this.records.saveThread(thread))
  }

  /** Reads the records; a failure is logged and gives `fallback`. */
  private read<T>(work: () => T, fallback: T): T {
    try {
      return work()
    } catch (error) {
      console.error("Novadeck could not read its messages:", error)
      return fallback
    }
  }

  /** Writes to the records; a failure is logged, and the runner carries on. */
  private write(work: () => void): void {
    try {
      work()
    } catch (error) {
      console.error("Novadeck could not save its messages:", error)
    }
  }
}
