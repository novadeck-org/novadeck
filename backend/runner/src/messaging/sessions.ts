import type { AgentName } from "@novadeck/protocol"

import type { Root, RootChange } from "../harnesses/roots.js"
import type { DeliveryEvent } from "./delivery.js"
import { addressed, awaiting, standingOf, started, type Live, type Scope } from "./live.js"
import type { Loops } from "./loops.js"
import type { MessageStore } from "./message-store.js"
import { undelivered, type Held } from "./messages.js"

/** What the running terminals ask of the rest of messaging. */
export type SessionsHost = {
  readonly store: MessageStore
  readonly loops: Loops
  readonly now: () => number
  /** Moves the terminal's delivery on (`Deliveries.step`). */
  readonly step: (live: Live, event: DeliveryEvent) => void
  /** Lets go of the brief the terminal's lead waits on; whether there was one. */
  readonly letBriefGo: (terminalId: string) => boolean
}

/**
 * The running terminals, as messaging knows them, and their root sessions: which messages
 * each session's coming and going makes its own, or gone.
 */
export class Sessions {
  private readonly live = new Map<string, Live>()
  /**
   * The terminals closed for good, so a message one sent that arrives after is marked so.
   * In memory only: after a runner restart, a terminal closed before it isn't known closed.
   */
  private readonly closedForGood = new Set<string>()
  /** The terminals resting with no process yet: asleep, until `register` starts one. */
  private readonly asleepIds = new Set<string>()

  constructor(private readonly host: SessionsHost) {}

  get(terminalId: string): Live | undefined {
    return this.live.get(terminalId)
  }

  has(terminalId: string): boolean {
    return this.live.has(terminalId)
  }

  /** Whether the terminal closed for good since this runner started. */
  closed(terminalId: string): boolean {
    return this.closedForGood.has(terminalId)
  }

  /** Whether the terminal rests with no process started for it: asleep, not yet waking. */
  asleep(terminalId: string): boolean {
    return this.asleepIds.has(terminalId)
  }

  /** The terminals asleep; the live view. */
  sleepers(): IterableIterator<string> {
    return this.asleepIds.values()
  }

  /** The terminal resting on that agent session, if one does: asleep, or woken and not yet bound. */
  holder(agent: AgentName, sessionId: string): string | undefined {
    for (const live of this.live.values())
      if (live.resting?.agent === agent && live.resting.sessionId === sessionId)
        return live.terminalId
    return undefined
  }

  /** Every running terminal; the live view. */
  all(): IterableIterator<Live> {
    return this.live.values()
  }

  /** The other running terminals in the terminal's project and session. */
  scoped(live: Live): Live[] {
    return [...this.live.values()].filter(
      (peer) =>
        peer.projectId === live.projectId &&
        peer.sessionId === live.sessionId &&
        peer.terminalId !== live.terminalId,
    )
  }

  /**
   * A terminal starts, or starts again, with the handle its record keeps, and the id of
   * the terminal that leads it (`ledBy`), if one does. It sees, and is seen by, the
   * terminals of its project and Novadeck session.
   */
  register(terminalId: string, scope: Scope, handle: string, ledBy: string | null): void {
    const existing = this.live.get(terminalId)
    if (existing) {
      // A sleeper starts: the same record, as it starts, its messages untouched and never
      // gone, still resting on its session until a root binds.
      if (!this.asleepIds.delete(terminalId)) return
      this.become(existing, started(terminalId, scope, handle, ledBy), existing.resting)
      this.host.store.changed(terminalId)
      return
    }
    this.closedForGood.delete(terminalId)
    this.live.set(terminalId, started(terminalId, scope, handle, ledBy))
  }

  /**
   * A terminal moves to another Novadeck session of its project, still running or resting:
   * its record turns in place, as others hold it by identity, and nothing else of it
   * changes. Its handle and lead there are the ones given. Nothing for a terminal not held.
   */
  move(terminalId: string, scope: Scope, handle: string, ledBy: string | null): void {
    const live = this.live.get(terminalId)
    if (!live) return
    Object.assign(live, scope, { handle, ledBy })
    this.host.store.changed(terminalId)
  }

  /**
   * A terminal rests on its saved session with no process: new, or one that ran (a stopped
   * idle agent). Its messages are untouched, they wait for the session; it is no root, and
   * never ringable. Resting again while asleep only turns the session it rests on.
   */
  rest(
    terminalId: string,
    scope: Scope,
    handle: string,
    ledBy: string | null,
    resting: NonNullable<Live["resting"]>,
  ): void {
    this.closedForGood.delete(terminalId)
    const existing = this.live.get(terminalId)
    const fresh = started(terminalId, scope, handle, ledBy)
    if (existing) {
      this.host.loops.reset(terminalId)
      this.become(existing, fresh, { ...resting })
    } else this.live.set(terminalId, { ...fresh, resting: { ...resting } })
    this.asleepIds.add(terminalId)
    this.host.store.changed(terminalId)
  }

  /**
   * A woken terminal's agent will not come, as its shell is back with nothing bound: it no
   * longer rests on the session, so nothing is addressed to it and its Inbox asks lapse,
   * and reopen should that session bind there after all. A terminal still asleep rests on.
   */
  endRest(terminalId: string): void {
    const live = this.live.get(terminalId)
    if (!live?.resting || this.asleepIds.has(terminalId)) return
    live.resting = null
    this.host.store.changed(terminalId)
  }

  /** The record turns into `next` in place, as others hold it by identity. */
  private become(live: Live, next: Live, resting: Live["resting"]): void {
    Object.assign(live, next, { resting })
  }

  /**
   * A terminal stops running, as it exits or closes: every message for it is gone, those
   * waiting for its first session too, until its session runs there again. With `forGood`,
   * as it closes, the brief its lead waits on is let go too; otherwise it is kept, as the
   * terminal may be restored with its lead.
   */
  unregister(terminalId: string, forGood = false, reason = "terminal-closed"): void {
    const { store } = this.host
    // Told to those waiting on it, which stop.
    if (forGood && this.host.letBriefGo(terminalId)) store.changed(terminalId)
    if (forGood) this.closedForGood.add(terminalId)
    const live = this.live.get(terminalId)
    if (!live) return
    this.applyRoot(live, [{ type: "ended" }])
    for (const message of store.messages())
      if (message.to.terminalId === terminalId && undelivered(message)) store.gone(message, reason)
    this.live.delete(terminalId)
    this.asleepIds.delete(terminalId)
    this.host.loops.forget(terminalId)
  }

  /**
   * How the terminal's root changed, as the terminal manager follows it (`followRoot`), and
   * the rules notes its root session holds in its context, where the manager tells them:
   * as it kept them with that session (its root changed, as after a restart), or none after
   * a compaction. Its later deliveries point to these, and give the rest in full.
   */
  rooted(terminalId: string, changes: readonly RootChange[], held?: Held): void {
    const live = this.live.get(terminalId)
    if (!live) return
    this.applyRoot(live, changes)
    if (held && live.root) live.held = held
  }

  /** Whether messages wait, or went, for that session of the terminal. */
  awaits(terminalId: string, sessionId: string): boolean {
    for (const message of this.host.store.messages())
      if (
        message.to.terminalId === terminalId &&
        message.to.sessionId === sessionId &&
        (undelivered(message) || message.state === "gone")
      )
        return true
    return false
  }

  /**
   * Restoring is over: messages for a session that doesn't run in their terminal, as one
   * never restored, are gone, and wait again should that session run there. Those waiting
   * for a terminal's first session wait on.
   */
  restored(): void {
    const { store } = this.host
    for (const message of store.messages()) {
      if (!undelivered(message) || message.state === "leased") continue
      if (message.to.sessionId === null) continue
      const live = this.live.get(message.to.terminalId)
      const standing = live && standingOf(live)
      // The session it runs, or rests on, asleep or just woken.
      if (standing && addressed(message, standing)) continue
      // The session the agent showing its prompt there is about to bind.
      if (live && !live.root && awaiting(live, message)) continue
      store.gone(message, "session-not-restored")
    }
  }

  /** Applies the root's changes to the terminal's messages and delivery, in order. */
  private applyRoot(live: Live, changes: readonly RootChange[]): void {
    const { store } = this.host
    for (const change of changes) {
      // What one session holds in its context, another doesn't.
      live.held = {}
      if (change.type === "ended") {
        if (!live.root) continue
        live.root = null
        live.withdrawing = null
        live.automatic = []
        this.host.loops.reset(live.terminalId)
        // A session already shown at its prompt in its place keeps the state it gave.
        if (!live.shown) this.host.step(live, { type: "unbound" })
        // Messages for the session that ended are gone; those for the first session the
        // terminal expects wait on, until it closes.
        for (const message of store.messages())
          if (
            message.to.terminalId === live.terminalId &&
            message.to.sessionId !== null &&
            undelivered(message)
          )
            store.gone(message, "session-ended")
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
    startedAt = this.host.now(),
    firedAt?: number,
  ): void {
    const { store } = this.host
    const resting = live.resting
    live.root = root
    live.resting = null
    live.withdrawing = null
    live.automatic = []
    this.host.loops.reset(live.terminalId)
    // Its first session came: from now on, only a bound session takes messages.
    live.expecting = null
    live.shown = null
    live.untrusted = null
    // Judged by when the hook that bound it started, not when it was heard, as a loaded
    // machine boots the hook late: the person's Enter before it may have submitted.
    this.host.step(live, {
      type: "bound",
      ready,
      at: startedAt,
      ...(firedAt !== undefined && { firedAt }),
    })
    for (const message of store.messages()) {
      if (message.to.terminalId !== live.terminalId) continue
      // A guess at the session a sleeper woke into stands for it: what waited for the saved
      // session follows, and `correct` moves it on to the session itself.
      if (
        guess &&
        resting &&
        undelivered(message) &&
        addressed(message, resting) &&
        message.to.sessionId !== root.sessionId
      ) {
        store.put({ ...message, to: { ...message.to, sessionId: root.sessionId } })
        continue
      }
      if (message.to.sessionId === null) {
        if (!undelivered(message)) continue
        if (message.to.agent === root.agent)
          store.put({ ...message, to: { ...message.to, sessionId: root.sessionId } })
        else store.gone(message, "other-agent")
      } else if (addressed(message, root)) {
        if (message.state === "gone") store.wait(message)
      } else if (!guess && undelivered(message)) store.gone(message, "other-session")
    }
  }

  /**
   * Corrects the root's session, as a guess at it is replaced by a better one: messages
   * sent to the guess go to it, and its own that were gone wait again. Once its status
   * line names it, messages for any other session there are gone.
   */
  private correct(live: Live, from: string, root: Root, confirmed: boolean): void {
    const { store } = this.host
    live.root = root
    for (const message of store.messages()) {
      const { to } = message
      if (to.terminalId !== live.terminalId) continue
      if (to.agent === root.agent && to.sessionId === from && from !== root.sessionId) {
        if (undelivered(message))
          store.put({ ...message, to: { ...to, sessionId: root.sessionId } })
      } else if (addressed(message, root)) {
        if (message.state === "gone") store.wait(message)
      } else if (confirmed && to.sessionId !== null && undelivered(message))
        store.gone(message, "other-session")
    }
  }
}
