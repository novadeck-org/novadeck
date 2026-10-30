import { stat } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"

import type { ActivityEvent, HarnessEvent, SessionObserved } from "@novadeck/harness-core/events"
import type { AgentName, TerminalSummary } from "@novadeck/protocol"

import {
  type Activity,
  apply,
  blocking,
  escapeScreenMs,
  escapeVerdictMs,
  summary as activitySummary,
  withLimit,
} from "../../harnesses/activity.js"
import { harnesses } from "../../harnesses/registry.js"
import { lastReply } from "../../harnesses/replies.js"
import { limitOf, observeTelemetry, telemetrySummary } from "../../harnesses/telemetry.js"
import type { Messaging } from "../../messaging/messaging.js"
import { standingDone } from "../../messaging/peers.js"
import type { Companion } from "../companion.js"
import { failed } from "../failures.js"
import { markTurn } from "../interrupted.js"
import type { Record } from "../record.js"
import { hasRun } from "../records.js"
import { TurnEnds, type TurnsHost } from "../turn-ends.js"
import type { Typing } from "../typing.js"
import { savedSession } from "./standing.js"

/**
 * How long after the person's Enter at an agent's own prompt, before its first, a session
 * must bind or a turn show, or that Enter submitted no prompt (a command such as Codex's
 * `/status`, or nothing): a prompt binds in about a second (probed 2026-10-04, 0.159.3).
 */
export const readyReturnMs = 5000

// The interruptions a terminal keeps for its chat: more than a session's chat shows.
const maxInterruptions = 256

export type BindingsHost = {
  /** The runner is stopping: an Escape's verdict changes nothing any more. */
  readonly stopping: () => boolean
  readonly messaging: () => Messaging
  readonly typing: () => Typing
  readonly companion: () => Companion
  /** Reports the record's current summary to every watcher. */
  readonly announce: (record: Record) => void
  /** Saves what restores the terminal, without its screen. */
  readonly save: (record: Record) => void
  /** Tells the terminal's detail readers of a change. */
  readonly detailed: (record: Record) => void
  /** Follows the terminal's root session after a report's facts; true when its work changed. */
  readonly trackRoot: (
    record: Record,
    events: readonly HarnessEvent[],
    statusLine: boolean,
  ) => boolean
  /** Follows the root after the terminal's binding changed outside its hooks' reports. */
  readonly rebound: (record: Record) => void
  /** Where finished turns are stored: the Inbox's entries and the redactor that masks their text. */
  readonly turns: () => TurnsHost
  /** Whether process `pid` still runs. */
  readonly alive: (pid: string) => boolean
  /** How often foreground processes are sampled: how long a shell outlives its agent to count. */
  readonly pollMs: number
}

/**
 * The agent bound to each terminal, as its hooks and its own sources tell: what applies
 * their facts to its activity and telemetry, the sources that follow it, the Escape's
 * verdict, the ends of its binding and its lead, and its agent as the terminal's summary
 * shows it. The binding itself, with its activity and telemetry, is a terminal record's `bound`.
 */
export class Bindings {
  private readonly ends = new TurnEnds({
    turns: () => this.host.turns(),
    owner: (terminalId) => this.host.messaging().inboxOwner(terminalId),
  })
  constructor(readonly host: BindingsHost) {}

  /**
   * Ends the binding of an agent process known to have exited without the shell showing
   * its prompt, as in tmux, a nested shell or `claude ; codex`: whatever shows or binds
   * there next is another agent's. Whether it ended one. Where its reports name no
   * process, nothing tells, and the binding stays until the shell's prompt.
   */
  endExited(record: Record): boolean {
    const binding = record.bound?.binding
    if (!binding?.instance || this.host.alive(binding.instance)) return false
    record.left = binding
    // The agent's process is gone: the lead it had ends with it.
    this.endLeadGone(record)
    return this.endBinding(record)
  }

  /**
   * Ends the terminal's lead as the agent it led is found gone, its process or the shell's
   * prompt telling. Windows ends every console program just before its shell as it shuts
   * down, and the runner stops only after: there the lead ends once the shell has outlived
   * its agent for a sample's time, so an agent ended that way resumes still led, as its
   * session resumes (`Sampler.prompted`). The runner stopping, the shell ending or
   * replaced meanwhile, or another lead meanwhile, keeps it. It is kept with the terminal's next save, as the
   * session the sampler let go of at the same moment is, so no saved terminal resumes its
   * agent unled.
   */
  endLeadGone(record: Record): void {
    if (process.platform !== "win32") return this.endLead(record)
    const shell = record.terminal.pty
    const lead = record.summary.ledBy
    setTimeout(() => {
      if (this.host.stopping() || record.closed || record.terminal.pty !== shell) return
      if (record.terminal.exit !== null || record.terminal.exiting) return
      // A lead the person approved meanwhile is a new one, not the one that ended.
      if (record.summary.ledBy !== lead) return
      this.endLead(record, false)
    }, this.host.pollMs).unref()
  }

  /**
   * Ends the terminal's lead, as the agent it led exited: kept (at once, or with the
   * terminal's next save), shown to watchers, and told to messaging, so what the former
   * lead sends reads as a peer's from then on.
   */
  endLead(record: Record, now = true): void {
    if (record.summary.ledBy === null) return
    record.summary = { ...record.summary, ledBy: null }
    record.suspended = null
    this.host.messaging().endLead(record.summary.id)
    if (now) this.host.save(record)
    else record.changed = true
    this.host.announce(record)
  }

  /**
   * Gives the terminal a lead the person approved, to a terminal that already runs an
   * agent: kept, shown to watchers, and told to messaging, so what the lead sends reads
   * as a lead's from then on. The inverse of `endLead`.
   */
  setLead(record: Record, handle: string): void {
    record.summary = { ...record.summary, ledBy: handle }
    this.host.messaging().setLead(record.summary.id, handle)
    this.host.save(record)
    this.host.announce(record)
  }

  /**
   * Ends the bound session, the one way every end takes: its binding, with its activity and
   * telemetry (`Record.bound`), and the sources that follow it. What is left after is
   * the shell's: still there (`endBinding`, `forgotten`), gone (`exited`), or new
   * (`restarted`).
   */
  private endSession(record: Record): void {
    record.bound = null
    record.resumeEnded = true
    this.unwatch(record)
  }

  /**
   * The session ended in a shell still there: its root is followed anew (`rebound`), and
   * the agent is published gone (`publishAgent`): the summary shows the prompt still shown as
   * ready, announced where it changed. What the shell keeps stays: an agent a Ctrl+Z left
   * `suspended`, which its lead waits on, and the entry seen in a transcript, which only that
   * transcript's session reads, as it comes back from `fg` or a resume.
   */
  private kept(record: Record): void {
    this.host.rebound(record)
    this.publishAgent(record, false)
  }

  /**
   * Ends the terminal's binding; with `only`, only while that session is still the one
   * bound. Whether it ended one.
   */
  endBinding(record: Record, only?: string): boolean {
    if (only !== undefined && record.bound?.binding.sessionId !== only) return false
    this.endSession(record)
    this.kept(record)
    return true
  }

  /**
   * Ends the binding of a harness that was disconnected, as `endBinding` does; the summary
   * says again whether an agent ran there, from the sessions the terminal still has.
   */
  forgotten(record: Record): void {
    this.endSession(record)
    this.kept(record)
  }

  /**
   * The shell exited: the session ends, and what the shell held with it, its root not
   * followed anew, nothing suspended and no entry seen in a transcript, as a restart starts
   * from (`restarted`). The caller shows neither agent nor ready prompt, and announces and
   * saves. The turn kept for a restart of Novadeck (`markTurn`) ends with the session: a shell
   * that died, or was restarted, mid-turn has nothing cut for a later restart to tell of.
   */
  exited(record: Record): void {
    this.endSession(record)
    if (markTurn(record, null)) record.changed = true
    Object.assign(record, this.shellEnded())
  }

  /**
   * What a restarted shell starts from, as the record's fields: no binding (it ended as the
   * shell exited, and its sources with it), and nothing of the shell before (`shellEnded`).
   * The binding a session found gone (`left`) stays.
   */
  restarted(): Pick<
    Record,
    "bound" | "suspended" | "root" | "seenEntry" | "watching" | "transcript"
  > {
    return {
      bound: null,
      watching: null,
      transcript: null,
      ...this.shellEnded(),
    }
  }

  /**
   * What the shell held of its agents, which ends with it, as it exits or restarts. The rest
   * of a shell's state (its prompts, line, foreground) the restart sets for the new one.
   */
  private shellEnded(): Pick<Record, "suspended" | "root" | "seenEntry"> {
    return { suspended: null, root: null, seenEntry: undefined }
  }

  /**
   * Follows the newly bound session's own sources, as its transcript, until its binding
   * ends; what they say applies like its hooks' reports.
   */
  follow(record: Record, event: SessionObserved): void {
    this.unwatch(record)
    record.transcript = event.transcript ?? null
    const binding = record.bound?.binding
    const watch = binding && harnesses[binding.agent].watch
    if (!binding || !watch || event.transcript === undefined) return
    const controller = new AbortController()
    record.watching = controller
    const run = {
      sessionId: binding.sessionId,
      instance: binding.instance,
      transcript: event.transcript,
    }
    void watch(run, controller.signal, (fact) => {
      if (record.watching !== controller || fact.type === "session-observed") return
      this.sourceFact(record, fact)
    }).catch(failed.following)
  }

  /** Applies what the bound session's own sources said, as its hooks' reports apply. */
  sourceFact(record: Record, fact: Exclude<HarnessEvent, SessionObserved>): void {
    const running = record.bound?.activity.state === "working"
    const applied = this.applyFact(record, fact)
    if (applied) this.publishAgent(record, false)
    // What only its records say, as an interrupted turn, reaches messaging too. A turn's
    // end its records told does only where it ended the turn, never a record used up as a
    // continued Stop's, with what the activity holds the turn left running, so the two
    // tell the same.
    const ended = applied && running && record.bound?.activity.state === "idle"
    const facts =
      fact.type !== "turn-ended" || !fact.recorded
        ? [fact]
        : ended
          ? [{ ...fact, background: record.bound?.activity.background ?? { agents: 0, tasks: 0 } }]
          : []
    if (this.host.trackRoot(record, facts, false)) this.host.save(record)
    this.host.messaging().observe(record.summary.id, facts)
    this.escaped(record)
  }

  /**
   * The person's Escape that may have cancelled the root turn, as delivery took it, ends
   * the turn for the agent's activity too, so the two tell the same.
   */
  escaped(record: Record): void {
    const binding = record.bound?.binding
    const event = binding && this.host.messaging().escaped(record.summary.id, binding)
    if (!event) return
    if (this.applyFact(record, event)) this.publishAgent(record, false)
    // Where its transcript stood at the key, for the chat to show the interruption it
    // doesn't record, should the Escape stand.
    const { transcript } = record
    record.escape =
      !harnesses[binding.agent].records && transcript
        ? {
            key: event.startedAt,
            offset: stat(transcript).then(
              ({ size }) => size,
              () => undefined,
            ),
          }
        : undefined
    this.awaitVerdict(record, event)
  }

  /**
   * Keeps where the person's latest Escape interrupted the turn, for a session whose
   * transcript doesn't record it, once it stands: the window passed with the turn still
   * interrupted, or the person's next turn began within it, before anything said the turn
   * finished. `before` is the last turn as it was before the fact just applied.
   */
  private interruptionStood(record: Record, before: Activity["lastTurn"] | undefined): void {
    const { escape, bound } = record
    if (!escape || !bound) return
    const { lastTurn: last, state } = bound.activity
    const confirmed = last?.outcome === "interrupted" && last.at === escape.key && !last.escaped
    const overtaken =
      before?.outcome === "interrupted" &&
      before.at === escape.key &&
      before.escaped !== undefined &&
      !last &&
      state === "working"
    if (!confirmed && !overtaken) return
    record.escape = undefined
    const { sessionId } = bound.binding
    void escape.offset.then((offset) => {
      if (offset === undefined || record.bound?.binding.sessionId !== sessionId) return
      const kept = record.interruptions ?? []
      record.interruptions = [...kept, { sessionId, offset, at: escape.key }].slice(
        -maxInterruptions,
      )
    })
  }

  /**
   * The harness has `escapeVerdictMs` to say how the turn the Escape ended ended, as its
   * reply may have reached it first. Once that passes, a Stop it reported meanwhile is the
   * turn's end, else a reply the transcript of a harness without records holds since the
   * person's prompt, else the Escape stands.
   */
  awaitVerdict(record: Record, { agent, sessionId, instance, startedAt }: ActivityEvent) {
    if (record.verdict) clearTimeout(record.verdict)
    const lapse = (reply: string | undefined) => {
      const binding = record.bound?.binding
      if (!binding || binding.sessionId !== sessionId || this.host.stopping()) return
      const lapsed: ActivityEvent = {
        type: "turn-escape-lapsed",
        agent,
        sessionId,
        instance,
        startedAt,
        ...(reply !== undefined && { reply }),
      }
      if (this.applyFact(record, lapsed)) this.publishAgent(record, false)
    }
    record.verdict = setTimeout(() => {
      record.verdict = undefined
      const reading = this.unstoppedReply(record, agent)
      if (reading) void reading.then(lapse)
      else lapse(undefined)
    }, escapeVerdictMs)
    record.verdict.unref()
  }

  /**
   * The read of the reply the transcript holds since the person's prompt of the turn their
   * Escape ended, where no Stop came for it and the harness keeps no records that would
   * say how it ended: undefined where there is nothing to read, and the read's undefined
   * where it holds none, can't be read, or the screen doesn't show the turn went on
   * uninterrupted, as Antigravity may say it stopped under a reply it kept. The screen is
   * what tells: an Escape between a response's words and the tool call after them leaves
   * the words recorded alone as the response, just as a reply that won is recorded, and
   * Antigravity drew its interruption under them every time (probed 2026-10-11, 1.2.14,
   * the call streamed 1.5 s after the words); a step's time is no help, as the cut-off
   * one came 56 to 94 ms after the key, where a reply that just won lands too. Only on
   * Windows, the one place a reply that won the race was seen to fire no Stop (Antigravity
   * 1.2.14): elsewhere its Stop tells.
   */
  unstoppedReply(record: Record, agent: AgentName): Promise<string | undefined> | undefined {
    if (process.platform !== "win32") return undefined
    const escaped = record.bound?.activity.lastTurn?.escaped
    const items = harnesses[agent].transcripts?.items
    if (harnesses[agent].records || !escaped || escaped.held || escaped.settled) return undefined
    if (!record.transcript || !items) return undefined
    const { interrupted } = harnesses[agent].box
    return lastReply(record.transcript, items)
      .then(async (reply) => {
        if (reply === undefined || !interrupted) return reply
        // The word may be drawn after the reply, so the screen is read again until the
        // window ends: the Escape stands where a read shows the word, or where the last
        // read can't tell (mid-redraw, under a dialog), and the reply won only where the
        // last shows it alone.
        const until = Date.now() + escapeScreenMs
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- Each read waits for the one before.
          const screen = await this.host.typing().screenOf(record.summary.id)
          if (!screen) return undefined
          const shown = interrupted(screen)
          if (shown === true) return undefined
          if (Date.now() >= until) return shown === false ? reply : undefined
          // eslint-disable-next-line no-await-in-loop -- Each read waits for the one before.
          await sleep(250, undefined, { ref: false })
        }
      })
      .catch(() => undefined)
  }

  /** Applies what the bound session's hooks or records said; true when it changed. */
  applyFact(record: Record, fact: Exclude<HarnessEvent, SessionObserved>): boolean {
    const waited = blocking(record.bound?.activity.pending).length > 0
    const before = record.bound?.activity.lastTurn
    const applied = this.appliedFact(record, fact)
    if (applied) this.interruptionStood(record, before)
    // A request no longer waits on the person: what they typed meanwhile counts now, at
    // once, before the report's prompt reaches messaging. The doorbell looks again too, as
    // the request kept it from ringing and its screen may not change.
    const waits = blocking(record.bound?.activity.pending).length > 0
    if (waited && !waits) {
      this.host.messaging().askedCleared(record.summary.id)
      this.host.typing().doorbellChanged(record.summary.id)
    }
    // A request asked while a ring is under way (none waited as it began) may show its
    // dialog where the ring's Enter would land: the ring fails, pressing nothing more, as
    // its line may already be in that dialog.
    const nonce = waits ? this.host.messaging().ringing(record.summary.id) : undefined
    if (nonce !== undefined) this.host.messaging().ringFailed(record.summary.id, nonce)
    if (applied) this.watchActors(record)
    return applied
  }

  /**
   * Follows each running subagent with a request waiting in its own sources, where its
   * harness reads them, for what ends its turn that no hook reports (Codex's rollout
   * recording Esc on its request): from its oldest request's ask, until it has none
   * waiting or the binding ends. What they say applies like its hooks' reports.
   */
  watchActors(record: Record): void {
    const { bound, transcript, actorWatches } = record
    const binding = bound?.binding
    const watchActor = binding && harnesses[binding.agent].watchActor
    const waiting = new Map<string, number>()
    if (bound && transcript !== null && watchActor)
      for (const { actor, askedAt } of bound.activity.pending)
        if (actor !== null && bound.activity.subagents.some(({ id }) => id === actor))
          waiting.set(actor, Math.min(askedAt, waiting.get(actor) ?? Number.POSITIVE_INFINITY))
    for (const [actor, { controller, since }] of actorWatches)
      if (waiting.get(actor) !== since) {
        controller.abort()
        actorWatches.delete(actor)
      }
    if (!binding || !watchActor || transcript === null) return
    const run = { sessionId: binding.sessionId, instance: binding.instance, transcript }
    for (const [actor, since] of waiting) {
      if (actorWatches.has(actor)) continue
      const controller = new AbortController()
      actorWatches.set(actor, { controller, since })
      void watchActor(run, actor, since, controller.signal, (fact) => {
        if (actorWatches.get(actor)?.controller !== controller) return
        if (fact.type === "session-observed") return
        this.sourceFact(record, fact)
      }).catch(failed.followingSubagent)
    }
  }

  appliedFact(record: Record, fact: Exclude<HarnessEvent, SessionObserved>): boolean {
    const { bound } = record
    if (!bound) return false
    const { binding } = bound
    if (fact.type === "telemetry-observed") {
      const next = observeTelemetry(bound.telemetry, binding, fact)
      if (next) record.bound = { ...bound, telemetry: next }
      if (next) this.latchLimit(record)
      return next !== undefined
    }
    const next = apply(bound.activity, binding, fact)
    if (next) record.bound = { ...bound, activity: next }
    if (next && fact.type === "plan-observed")
      void this.host.companion().planned(record, binding, fact)
    if (next && fact.type === "turn-ended") this.latchLimit(record)
    return Boolean(next)
  }

  /**
   * Latches the usage-limit window a turn that just ended, or one idle since, ran into on
   * its last turn, from the limits the session's records showed (`limitOf`).
   */
  latchLimit(record: Record): void {
    const { bound } = record
    if (!bound?.telemetry || bound.activity.state !== "idle") return
    const { activity, telemetry } = bound
    const limit = limitOf(activity.lastTurn, telemetry.limits, telemetry.at)
    const next = limit && withLimit(activity, limit)
    if (next) record.bound = { ...bound, activity: next }
  }

  unwatch(record: Record): void {
    // Ends still in their grace are stored: the session can say no more of them.
    this.ends.flush(record.summary.id)
    record.watching?.abort()
    record.watching = null
    for (const { controller } of record.actorWatches.values()) controller.abort()
    record.actorWatches.clear()
    record.transcript = null
    for (const reader of record.sourceReaders) reader.abort()
    record.sourceReaders.clear()
  }

  /**
   * Shows the bound agent and its activity in the summary, announcing a change, or the
   * summary's own change when `moved`.
   */
  publishAgent(record: Record, moved: boolean): void {
    // Detail changes where the summary may not: a revised request, a subject.
    this.host.detailed(record)
    this.host.typing().dialogsChanged(record.summary.id)
    const { bound } = record
    const agent = bound?.binding.agent ?? null
    const ready = this.readyOf(record)
    const activity = bound ? activitySummary(bound.activity) : null
    // Before the early return below: an Escape that settles changes nothing the summary shows.
    this.ends.sight(record, activity)
    // What the turn was doing is kept for a restart of Novadeck (`markTurn`), saved at once.
    if (markTurn(record, activity)) {
      record.changed = true
      this.host.save(record)
    }
    const telemetry = bound?.telemetry ? telemetrySummary(bound.telemetry) : null
    const reported = this.reportedOf(record)
    const agentRan = hasRun(record.agents)
    const { summary } = record
    if (
      !moved &&
      summary.agentRan === agentRan &&
      summary.agent === agent &&
      summary.ready === ready &&
      JSON.stringify(summary.activity) === JSON.stringify(activity) &&
      JSON.stringify(summary.telemetry) === JSON.stringify(telemetry) &&
      JSON.stringify(summary.reported) === JSON.stringify(reported)
    )
      return
    record.summary = { ...summary, agentRan, agent, ready, activity, telemetry, reported }
    this.host.announce(record)
  }

  /**
   * The agent's `done` that still stands (`standingDone`), as the summary shows it: what
   * the person's prompt, a delivered message, another session or the agent's end can undo,
   * and looking at the terminal cannot.
   */
  private reportedOf(record: Record): TerminalSummary["reported"] {
    const id = record.summary.id
    // Before its agent binds a session again, as after a runner restart, the one resumed.
    const saved = savedSession(record)
    const done = standingDone(
      this.host.turns().inbox.reports(id, saved),
      record.work?.personAt,
      this.host.messaging().deliveredAt(id),
    )
    return done && { subject: done.subject, at: done.at }
  }

  /**
   * Something the standing `done` depends on changed (an Inbox entry, a delivered message,
   * the person's prompt): shows it in the summary, announced where it changed.
   */
  publishReported(record: Record): void {
    const reported = this.reportedOf(record)
    if (JSON.stringify(record.summary.reported) === JSON.stringify(reported)) return
    record.summary = { ...record.summary, reported }
    this.host.announce(record)
  }

  /**
   * The person pressed Enter at the agent's own prompt, before its first: until its
   * session binds, nothing says it is idle. Should neither a session bind nor its title say
   * a turn runs within `readyReturnMs`, the Enter submitted no prompt, and the prompt
   * still shows.
   */
  readyEnter(record: Record): void {
    record.readyEntered = true
    record.readyTurned = false
    this.publishAgent(record, false)
    if (record.readyReturn) clearTimeout(record.readyReturn)
    const child = record.terminal.pty
    record.readyReturn = setTimeout(() => {
      record.readyReturn = undefined
      if (record.terminal.pty !== child || record.terminal.exiting || record.bound) return
      if (!record.readyEntered || record.readyTurned) return
      record.readyEntered = false
      this.publishAgent(record, false)
    }, readyReturnMs)
    record.readyReturn.unref()
  }

  /** The agent whose own prompt shows there, with Novadeck's hooks, before any session bound. */
  readyOf(record: Record): AgentName | null {
    if (record.bound || record.readyEntered) return null
    return this.host.messaging().shownAgent(record.summary.id) ?? null
  }
}
