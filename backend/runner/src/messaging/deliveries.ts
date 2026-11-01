import type { ActivityEvent, Background, HarnessEvent } from "@novadeck/harness-core/events"
import type { AgentName } from "@novadeck/protocol"
import type { KeyKind } from "@novadeck/tui-input"

import type { Binding } from "../harnesses/bindings.js"
import { rootedIn } from "../harnesses/roots.js"
import {
  firing,
  pendingEnter,
  phaseOf,
  queueBarLeft,
  ringableSince,
  running,
  transition,
  waitsIn,
  type Delivery,
  type DeliveryEvent,
  type Waits,
} from "./delivery.js"
import { addressed, awaiting, feed, promptsInBackground, type Live } from "./live.js"
import type { Loops } from "./loops.js"
import type { MessageStore } from "./message-store.js"
import { isQuiet } from "./messages.js"
import type { Sessions } from "./sessions.js"

/**
 * Whether the agent is idle by its delivery, for a hold: what the doorbell rings or looks
 * at (Working on background work too, `inBackground`, where its box takes a prompt then),
 * or rings now, as a ring that fails, counted or not, ends no hold; only a turn does.
 */
const idle = (delivery: Delivery, inBackground: boolean): boolean =>
  ringableSince(delivery) !== undefined ||
  waitsIn(delivery, inBackground) ||
  delivery.state === "ringing"

/** How many of a terminal's latest unconfirmed rings it remembers (`Live.unconfirmed`). */
const maxUnconfirmed = 8

/**
 * Whether subagents a turn left running run on, to wake its agent: delivery's
 * `background`. Work its harness doesn't count may be one, until its status line counts
 * it (Antigravity's); a command alone never holds delivery, as one may run for ever.
 */
export const runsOn = (background: Background | undefined): boolean =>
  background !== undefined && (background.agents > 0 || background.more === true)

/** What each terminal's delivery state asks of the rest of messaging. */
export type DeliveriesHost = {
  readonly sessions: Sessions
  readonly store: MessageStore
  readonly loops: Loops
  readonly now: () => number
  /** How much later a hook may come, for the shell it starts in (see `firing`). */
  readonly slackMs: number
  /** A turn ended, or a new one began: the last one's delivery is left behind. */
  readonly leftBehind: (terminalId: string) => void
}

/**
 * Each terminal's delivery state (`delivery.ts`), as its root session's turns, the
 * person's keys, its screen and the doorbell's rings move it, and what the doorbell asks
 * of it.
 */
export class Deliveries {
  /** The terminals an answer is pressing its own keys in now (see `pressing`). */
  private readonly pressed = new Set<string>()

  constructor(readonly host: DeliveriesHost) {}

  /** The terminal's delivery state, while it runs. */
  delivery(terminalId: string): Delivery | undefined {
    return this.host.sessions.get(terminalId)?.delivery
  }

  /**
   * Expects an agent to bind in the terminal, as one it was opened to run: messages may
   * be addressed to it before it has, and wait for its first session. The expectation
   * ends once any root session binds there.
   */
  expect(terminalId: string, agent: AgentName | null): void {
    const live = this.host.sessions.get(terminalId)
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
    at = this.host.now(),
    firedAt?: number,
  ): void {
    const live = this.host.sessions.get(terminalId)
    if (!live || (live.root && !replaces)) return
    const learned = live.shown?.agent !== agent || live.shown.prefix !== prefix
    live.shown = { agent, prefix }
    live.untrusted = null
    this.step(live, { type: "shown", at, replaces, ...(firedAt !== undefined && { firedAt }) })
    // A prefix it learns later may make other messages its own.
    if (learned) {
      this.host.store.changed(terminalId)
      this.host.sessions.touched()
    }
  }

  /**
   * The person's Escape that may have cancelled the root turn, as delivery took it, as an
   * event for the bound session's activity, so both tell the same (see `turn-escaped`).
   * Each Escape is told once, as it ends the turn: a turn that went on after it, asking
   * the person something, keeps what it asked.
   */
  escaped(terminalId: string, binding: Binding): ActivityEvent | undefined {
    const live = this.host.sessions.get(terminalId)
    if (!live) return undefined
    const { delivery } = live
    if (delivery.state !== "unknown" || delivery.escapedAt === undefined) return undefined
    if (live.escapeTold === delivery.escapedAt) return undefined
    live.escapeTold = delivery.escapedAt
    const { agent, sessionId, instance } = binding
    const event: ActivityEvent = {
      type: "turn-escaped",
      agent,
      sessionId,
      instance,
      startedAt: delivery.escapedAt,
    }
    feed(this.host.loops, this.host.now, live, [event])
    return event
  }

  /** The agent whose hooks were found untrusted there, with no session bound, if any. */
  untrustedAgent(terminalId: string): AgentName | undefined {
    return this.host.sessions.get(terminalId)?.untrusted ?? undefined
  }

  /** The agent whose prompt shows there with no session bound, if any. */
  shownAgent(terminalId: string): AgentName | undefined {
    const live = this.host.sessions.get(terminalId)
    return live && !live.root ? live.shown?.agent : undefined
  }

  /**
   * The agent's own prompt shows in the terminal with no session bound, but Novadeck's
   * hooks aren't trusted for it there, as Codex's app-server says: until its prompt counts,
   * a session binds or it leaves, `send` refuses it, as nothing could deliver.
   */
  untrusted(terminalId: string, agent: AgentName): void {
    const live = this.host.sessions.get(terminalId)
    if (!live || live.root || live.untrusted === agent) return
    live.untrusted = agent
    this.host.store.changed(terminalId)
  }

  /** The agent whose prompt showed left before any session bound, as the shell's prompt says. */
  unshown(terminalId: string): void {
    const live = this.host.sessions.get(terminalId)
    if (live) live.untrusted = null
    if (!live?.shown) return
    live.shown = null
    this.host.sessions.touched()
    if (!live.root && live.delivery.state !== "unbound") this.step(live, { type: "unbound" })
  }

  /**
   * The person's keys to the terminal, apart from its automatic replies, while a request
   * waits on them (`asked`) or not, or an answer's own within `pressing`. Delivery alone
   * decides what they did to the box.
   */
  keys(terminalId: string, kinds: readonly KeyKind[], asked: boolean): void {
    const live = this.host.sessions.get(terminalId)
    if (!live) return
    const at = this.host.now()
    live.keyedAt = at
    // Novadeck's own keys answering the request, as `pressing` tells; never once none waits.
    const pressed = asked && this.pressed.has(terminalId)
    for (const key of kinds)
      this.step(live, pressed ? { type: "pressed", key, at } : { type: "key", key, asked, at })
  }

  /**
   * Runs `press`, which writes an answer's own keys to the terminal through the bookkeeping
   * the person's keys get (`keys`, which it calls at once): those keys, while a request
   * waits, are Novadeck's, pressed in the dialog the answer read, and leave no draft. Only
   * what `press` itself reports counts so: the person's keys, from any client or released
   * from an answer's hold, come by themselves, never within it.
   */
  pressing(terminalId: string, press: () => void): void {
    this.pressed.add(terminalId)
    try {
      press()
    } finally {
      this.pressed.delete(terminalId)
    }
  }

  /**
   * The terminal's screen shows its agent's own box empty and calm, read from `readAt` on, in
   * the `epoch` it was read in, where its delivery is Drafting, Unknown or Fresh: Settled
   * again where a turn completed (`completedAt`), else Ready.
   * Not after a key of the person's since the read, whose text it may not have shown.
   */
  emptied(terminalId: string, epoch: number, readAt = this.host.now()): void {
    const live = this.host.sessions.get(terminalId)
    if (!live || live.keyedAt >= readAt) return
    // Working on background work only where its box takes a prompt meanwhile.
    if (phaseOf(live.delivery) === "background" && !promptsInBackground(live)) return
    this.step(live, { type: "emptied", at: this.host.now(), epoch })
  }

  /**
   * Whether the terminal's agent is idle but not ringable by its state alone (Fresh,
   * Drafting or Unknown, or Working on background work only where its box takes a prompt
   * meanwhile), with messages waiting for it: the doorbell looks at its screen for an
   * empty box, and for a prompt the harness shows queued.
   */
  stalled(terminalId: string): boolean {
    const live = this.host.sessions.get(terminalId)
    if (!live) return false
    const { delivery } = live
    if (
      !waitsIn(delivery, promptsInBackground(live)) ||
      queueBarLeft(delivery, this.host.now(), this.host.slackMs) > 0
    )
      return false
    return this.waiting(live)
  }

  /**
   * How long the terminal's screen is not believed yet, after a Stop that left the person's
   * prompt queued for the harness to submit; 0 when no bar stands.
   */
  queueBar(terminalId: string): number {
    const delivery = this.host.sessions.get(terminalId)?.delivery
    return delivery ? queueBarLeft(delivery, this.host.now(), this.host.slackMs) : 0
  }

  /** Why the doorbell can't ring the terminal, as its screen shows; null once it can. */
  blocked(terminalId: string, waits: Waits | null): void {
    const live = this.host.sessions.get(terminalId)
    if (!live || live.waits === waits) return
    live.waits = waits
    this.host.store.changed(terminalId)
  }

  /** No request waits on the person any more: what they typed meanwhile counts now. */
  askedCleared(terminalId: string): void {
    const live = this.host.sessions.get(terminalId)
    if (live) this.step(live, { type: "asked-cleared" })
  }

  /**
   * Whether the doorbell may ring the terminal: Settled, or Ready (a new session at its
   * own prompt), with messages waiting for its root session. The doorbell waits for the
   * screen to settle, and checks it, before it rings.
   */
  ringable(terminalId: string): boolean {
    const live = this.host.sessions.get(terminalId)
    return live !== undefined && ringableSince(live.delivery) !== undefined && this.waiting(live)
  }

  /** Whether messages wait for the terminal's root session (or the one about to bind). */
  private waiting(live: Live): boolean {
    const { root, terminalId } = live
    for (const message of this.host.store.messages())
      if (
        message.state === "queued" &&
        !isQuiet(message) &&
        message.to.terminalId === terminalId &&
        (root ? addressed(message, root) : awaiting(live, message))
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
    const live = this.host.sessions.get(terminalId)
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
    const delivery = this.host.sessions.get(terminalId)?.delivery
    return delivery && ringableSince(delivery)
  }

  /**
   * Whether the terminal is Ready at a new session's own prompt, with no turn yet: not one
   * made Ready by its screen, which has had turns.
   */
  ready(terminalId: string): boolean {
    const live = this.host.sessions.get(terminalId)
    return live?.delivery.state === "ready" && !live.viaScreen
  }

  /** Whether the terminal is idle by its screen's word alone, not a Stop's or a session start's. */
  byScreen(terminalId: string): boolean {
    return this.host.sessions.get(terminalId)?.viaScreen === true
  }

  /**
   * A mark that changes with each root turn event (a delivery epoch) and each key
   * into the terminal, the person's or an answer's.
   */
  stamp(terminalId: string): string {
    const live = this.host.sessions.get(terminalId)
    return live ? `${live.delivery.epoch}:${live.keyedAt}` : ""
  }

  /** Whether the terminal is Settled or Ready with messages waiting for its agent. */
  idleWaiting(terminalId: string): boolean {
    const live = this.host.sessions.get(terminalId)
    return live !== undefined && ringableSince(live.delivery) !== undefined && this.waiting(live)
  }

  /**
   * When the person's bare Enter came, if a root turn whose hook started at `startedAt`,
   * its shell at `firedAt` where told, would be their submission: within the window,
   * before anything they typed after it.
   */
  pendingSubmission(terminalId: string, startedAt: number, firedAt?: number): number | undefined {
    const delivery = this.host.sessions.get(terminalId)?.delivery
    if (!delivery) return undefined
    const fired = firing(
      { at: startedAt, ...(firedAt !== undefined && { firedAt }) },
      this.host.slackMs,
    )
    return pendingEnter(delivery, fired.at, fired.windowMs)
  }

  /** The doorbell starts ringing the terminal with its nonce; false when it may not now. */
  ring(terminalId: string, nonce: string): boolean {
    const live = this.host.sessions.get(terminalId)
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
    return this.host.sessions.get(terminalId)?.unconfirmed.includes(nonce) === true
  }

  /**
   * The doorbell submits the doorbell line its screen shows alone in the box, as a ring that
   * failed or was abandoned left it, rung again under that line's own `nonce`: the terminal
   * is Ringing; false when it may not now.
   */
  ringLeftover(terminalId: string, nonce: string): boolean {
    const live = this.host.sessions.get(terminalId)
    if (!live || !this.stalled(terminalId) || !live.unconfirmed.includes(nonce)) return false
    this.step(live, { type: "ring", nonce, opening: !live.root, leftover: true })
    return live.delivery.state === "ringing"
  }

  /** The nonce of the ring under way in the terminal, if it is Ringing. */
  ringing(terminalId: string): string | undefined {
    const delivery = this.host.sessions.get(terminalId)?.delivery
    return delivery?.state === "ringing" ? delivery.nonce : undefined
  }

  /** The ring with that nonce failed: the terminal is Unknown, and its messages wait. */
  ringFailed(terminalId: string, nonce: string): void {
    const live = this.host.sessions.get(terminalId)
    if (live) this.step(live, { type: "ring-failed", nonce })
  }

  /** Applies a root turn event to the terminal's delivery. */
  turn(live: Live, event: HarnessEvent): void {
    if (!rootedIn(live.root, event)) return
    switch (event.type) {
      case "turn-started": {
        const { epoch } = live.delivery
        // Whose turn it is, and what it did to the box, delivery alone decides.
        this.step(live, {
          type: "prompt",
          by: event.cause,
          ...(event.nonce !== undefined && { nonce: event.nonce }),
          at: this.host.now(),
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
            at: this.host.now(),
            ...(event.recorded && { recorded: true }),
          })
        else this.step(live, { type: "ended", ...(event.recorded && { recorded: true }) })
        return
      case "turn-idle":
        this.step(live, {
          type: "idle",
          background: runsOn(event.background),
          at: this.host.now(),
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

  /** Moves the terminal's delivery on by one event, with what follows from the move. */
  step(live: Live, event: DeliveryEvent): void {
    const before = live.delivery
    // A doorbell prompt submitted its line: one in the box again is the person's.
    const confirmed = event.type === "prompt" && event.by === "doorbell" ? event.nonce : undefined
    if (confirmed !== undefined)
      live.unconfirmed = live.unconfirmed.filter((each) => each !== confirmed)
    live.delivery = transition(before, event, this.host.slackMs)
    if (live.delivery === before) return
    const { state } = live.delivery
    live.viaScreen =
      (event.type === "emptied" && (state === "ready" || state === "settled")) ||
      (live.viaScreen &&
        (state === "ready" || state === "settled") &&
        live.delivery.epoch === before.epoch)
    // The doorbell's last word on why it can't ring is about an idle agent only, or one
    // waiting on its background work, which it looks at too: not once that work is over.
    if (
      running(live.delivery) ||
      state === "ringing" ||
      state === "unbound" ||
      live.viaScreen ||
      (phaseOf(before) === "background" && phaseOf(live.delivery) !== "background")
    )
      live.waits = null
    // A hold is timed from the agent going idle; a turn ends it, as does a Stop, which ends
    // a turn that ran on unseen in Unknown (after an Escape that only closed a popup).
    const inBackground = promptsInBackground(live)
    if (!idle(live.delivery, inBackground)) live.idleSince = null
    else if (!idle(before, inBackground) || event.type === "stop") live.idleSince = this.host.now()
    // A turn that ended, or a new one, leaves the last one's delivery behind.
    if ((running(before) && !running(live.delivery)) || live.delivery.epoch !== before.epoch)
      this.host.leftBehind(live.terminalId)
    this.host.store.changed(live.terminalId)
  }
}
