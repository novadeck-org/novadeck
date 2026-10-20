import { setTimeout as sleep } from "node:timers/promises"

import type { ActivityEvent, HarnessEvent, SessionObserved } from "@novadeck/harness-core/events"
import type { AgentName } from "@novadeck/protocol"

import {
  apply,
  escapeScreenMs,
  escapeVerdictMs,
  summary as activitySummary,
  withLimit,
} from "../../harnesses/activity.js"
import { harnesses } from "../../harnesses/registry.js"
import { lastReply } from "../../harnesses/replies.js"
import { limitOf, observeTelemetry, telemetrySummary } from "../../harnesses/telemetry.js"
import type { Messaging } from "../../messaging/messaging.js"
import type { Companion } from "../companion.js"
import { failed } from "../failures.js"
import type { Record } from "../record.js"
import { hasRun } from "../records.js"
import type { Typing } from "../typing.js"

/**
 * How long after the person's Enter at an agent's own prompt, before its first, a session
 * must bind or a turn show, or that Enter submitted no prompt (a command such as Codex's
 * `/status`, or nothing): a prompt binds in about a second (probed 2026-10-04, 0.159.3).
 */
export const readyReturnMs = 5000

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
  /** Murmur writes a gist for what the activity now holds. */
  readonly murmurChanged: (terminalId: string) => void
  /** Follows the terminal's root session after a report's facts; true when its work changed. */
  readonly trackRoot: (
    record: Record,
    events: readonly HarnessEvent[],
    statusLine: boolean,
  ) => boolean
  /** Follows the root after the terminal's binding changed outside its hooks' reports. */
  readonly rebound: (record: Record) => void
  /** Whether process `pid` still runs. */
  readonly alive: (pid: string) => boolean
}

/**
 * The agent bound to each terminal, as its hooks and its own sources tell: what applies
 * their facts to its activity and telemetry, the sources that follow it, the Escape's
 * verdict, the ends of its binding and its lead, and its agent as the terminal's summary
 * shows it. The binding itself is still a terminal record's fields (see `Record`).
 */
export class Bindings {
  constructor(readonly host: BindingsHost) {}

  /**
   * Ends the binding of an agent process known to have exited without the shell showing
   * its prompt, as in tmux, a nested shell or `claude ; codex`: whatever shows or binds
   * there next is another agent's. Whether it ended one. Where its reports name no
   * process, nothing tells, and the binding stays until the shell's prompt.
   */
  endExited(record: Record): boolean {
    const { binding } = record
    if (!binding?.instance || this.host.alive(binding.instance)) return false
    record.left = binding
    // The agent's process is gone: the lead it had ends with it.
    this.endLead(record)
    return this.endBinding(record)
  }

  /**
   * Ends the terminal's lead, as the agent it led exited: kept, shown to watchers, and
   * told to messaging, so what the former lead sends reads as a peer's from then on.
   */
  endLead(record: Record): void {
    if (record.summary.ledBy === null) return
    record.summary = { ...record.summary, ledBy: null }
    record.suspended = null
    this.host.messaging().endLead(record.summary.id)
    this.host.save(record)
    this.host.announce(record)
  }

  /**
   * Lets go of the bound session's half of the record, all at once: without a binding,
   * `activity` and `telemetry` are null too, outside the moment a report binds a session
   * (see `Record.binding`). `endBinding`, `forgotten` and `exited` take all three through
   * here, `restarted` gives the same nulls as fields, and each differs from the others only
   * where it says so.
   */
  private unbind(record: Record): void {
    record.binding = null
    record.activity = null
    record.telemetry = null
  }

  /**
   * Ends the terminal's binding, with its activity and the sources that follow it; with
   * `only`, only while that session is still the one bound. Whether it ended one. The
   * root is followed anew (`rebound`); the summary shows no agent, and the prompt still
   * shown as ready, announced only where it showed an agent.
   */
  endBinding(record: Record, only?: string): boolean {
    if (only !== undefined && record.binding?.sessionId !== only) return false
    this.unbind(record)
    this.unwatch(record)
    this.host.rebound(record)
    if (record.summary.agent !== null) {
      record.summary = {
        ...record.summary,
        agent: null,
        ready: this.readyOf(record),
        activity: null,
        telemetry: null,
      }
      this.host.announce(record)
    }
    return true
  }

  /**
   * Ends the binding of a harness that was disconnected, as `endBinding` does, but the
   * summary also says again whether an agent ran there (`agentRan`, from the sessions it
   * still has), and it is announced whatever it showed before.
   */
  forgotten(record: Record, agentRan: boolean): void {
    this.unbind(record)
    this.unwatch(record)
    this.host.rebound(record)
    record.summary = {
      ...record.summary,
      agentRan,
      agent: null,
      ready: this.readyOf(record),
      activity: null,
      telemetry: null,
    }
    this.host.announce(record)
  }

  /**
   * The shell exited: the binding goes, and the root with it, without following the root
   * anew (no `rebound`) and before its sources are let go; the caller unwatches, shows
   * neither agent nor ready prompt, and announces.
   */
  exited(record: Record): void {
    this.unbind(record)
    record.root = null
  }

  /**
   * What a restarted shell starts from, as the record's fields: no binding (its sources
   * were let go as the shell exited), no root, nothing suspended and no entry seen in a
   * transcript. The binding a session found gone (`left`) stays.
   */
  restarted(): Pick<
    Record,
    | "binding"
    | "activity"
    | "telemetry"
    | "suspended"
    | "root"
    | "seenEntry"
    | "watching"
    | "transcript"
  > {
    return {
      binding: null,
      activity: null,
      telemetry: null,
      suspended: null,
      root: null,
      seenEntry: undefined,
      watching: null,
      transcript: null,
    }
  }

  /**
   * Follows the newly bound session's own sources, as its transcript, until its binding
   * ends; what they say applies like its hooks' reports.
   */
  follow(record: Record, event: SessionObserved): void {
    this.unwatch(record)
    record.transcript = event.transcript ?? null
    const { binding } = record
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
    const running = record.activity?.state === "working"
    const applied = this.applyFact(record, fact)
    if (applied) this.publishAgent(record, false)
    // What only its records say, as an interrupted turn, reaches messaging too. A turn's
    // end its records told does only where it ended the turn, never a record used up as a
    // continued Stop's, with what the activity holds the turn left running, so the two
    // tell the same.
    const ended = applied && running && record.activity?.state === "idle"
    const facts =
      fact.type !== "turn-ended" || !fact.recorded
        ? [fact]
        : ended
          ? [{ ...fact, background: record.activity?.background ?? { agents: 0, tasks: 0 } }]
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
    const { binding } = record
    const event = binding && this.host.messaging().escaped(record.summary.id, binding)
    if (!event) return
    if (this.applyFact(record, event)) this.publishAgent(record, false)
    this.awaitVerdict(record, event)
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
      const { binding } = record
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
    const escaped = record.activity?.lastTurn?.escaped
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
    const waited = (record.activity?.pending.length ?? 0) > 0
    const applied = this.appliedFact(record, fact)
    // A request no longer waits on the person: what they typed meanwhile counts now, at
    // once, before the report's prompt reaches messaging. The doorbell looks again too, as
    // the request kept it from ringing and its screen may not change.
    const waits = (record.activity?.pending.length ?? 0) > 0
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
    const { binding, activity, transcript, actorWatches } = record
    const watchActor = binding && harnesses[binding.agent].watchActor
    const waiting = new Map<string, number>()
    if (binding && activity && transcript !== null && watchActor)
      for (const { actor, askedAt } of activity.pending)
        if (actor !== null && activity.subagents.some(({ id }) => id === actor))
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
    if (!record.binding) return false
    if (fact.type === "telemetry-observed") {
      const next = observeTelemetry(record.telemetry, record.binding, fact)
      if (next) record.telemetry = next
      if (next) this.latchLimit(record)
      return next !== undefined
    }
    const next = record.activity && apply(record.activity, record.binding, fact)
    if (next) record.activity = next
    if (next && fact.type === "plan-observed")
      void this.host.companion().planned(record, record.binding, fact)
    if (next && fact.type === "turn-ended") this.latchLimit(record)
    return Boolean(next)
  }

  /**
   * Latches the usage-limit window a turn that just ended, or one idle since, ran into on
   * its last turn, from the limits the session's records showed (`limitOf`).
   */
  latchLimit(record: Record): void {
    const { activity, telemetry } = record
    if (!activity || !telemetry || activity.state !== "idle") return
    const limit = limitOf(activity.lastTurn, telemetry.limits, telemetry.at)
    const next = limit && withLimit(activity, limit)
    if (next) record.activity = next
  }

  unwatch(record: Record): void {
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
    // Murmur writes a gist for what the activity now holds.
    this.host.murmurChanged(record.summary.id)
    const agent = record.binding?.agent ?? null
    const ready = this.readyOf(record)
    const activity = record.binding && record.activity ? activitySummary(record.activity) : null
    const telemetry = record.binding && record.telemetry ? telemetrySummary(record.telemetry) : null
    const agentRan = hasRun(record.agents)
    const { summary } = record
    if (
      !moved &&
      summary.agentRan === agentRan &&
      summary.agent === agent &&
      summary.ready === ready &&
      JSON.stringify(summary.activity) === JSON.stringify(activity) &&
      JSON.stringify(summary.telemetry) === JSON.stringify(telemetry)
    )
      return
    record.summary = { ...summary, agentRan, agent, ready, activity, telemetry }
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
      if (record.terminal.pty !== child || record.terminal.exiting || record.binding) return
      if (!record.readyEntered || record.readyTurned) return
      record.readyEntered = false
      this.publishAgent(record, false)
    }, readyReturnMs)
    record.readyReturn.unref()
  }

  /** The agent whose own prompt shows there, with Novadeck's hooks, before any session bound. */
  readyOf(record: Record): AgentName | null {
    if (record.binding || record.readyEntered) return null
    return this.host.messaging().shownAgent(record.summary.id) ?? null
  }
}
