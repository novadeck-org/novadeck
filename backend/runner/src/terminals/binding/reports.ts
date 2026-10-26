import type { HarnessEvent, SessionObserved } from "@novadeck/harness-core/events"
import { firedFacts, silentFor } from "@novadeck/harness-core/harness"
import type { Report } from "@novadeck/harness-core/report"
import type { AgentName } from "@novadeck/protocol"
import { relayMs, shellInForeground, type ProcessTrees } from "@novadeck/terminal/pty"

import { boundSince, started as fresh } from "../../harnesses/activity.js"
import { observe, type Binding } from "../../harnesses/bindings.js"
import { harnesses } from "../../harnesses/registry.js"
import { unreplied, withReplies } from "../../harnesses/replies.js"
import { followRoot, rootedIn, type RootChange } from "../../harnesses/roots.js"
import { transcriptWaitMs, typedPromptStart } from "../../harnesses/typed-prompts.js"
import type { Asks } from "../../messaging/asks.js"
import { byteLength, maxDeliveryBytes } from "../../messaging/mailbox.js"
import { leaseMargin, type Messaging, type Person } from "../../messaging/messaging.js"
import type { HookAnswer } from "../../shell/reports.js"
import { sameToken } from "../callers.js"
import { promptIn } from "../commands.js"
import type { Companion } from "../companion.js"
import { failed } from "../failures.js"
import { tellInterrupted } from "../interrupted.js"
import type { Murmur } from "../murmur.js"
import { atPrompt, fired, noticesAt, sessionBegan } from "../nudges.js"
import { peerOf, type TerminalPeers } from "../peers.js"
import type { Record } from "../record.js"
import { boundProgram } from "../sampling.js"
import type { Typing } from "../typing.js"
import { judgedFirst, personPrompted, workAfter } from "../work.js"
import type { Bindings } from "./facts.js"
import type { Shown } from "./shown.js"

// How much time a prompt's hook must have left for drift to be read, in milliseconds:
// a git branch and a plan's file, each with its own short timeout.
const driftReadMs = 1_500

export type ReportsHost = {
  /** Every terminal the runner holds, by id. */
  readonly records: () => ReadonlyMap<string, Record>
  readonly messaging: () => Messaging
  readonly asks: () => Asks
  readonly peers: () => TerminalPeers
  readonly murmur: () => Murmur | undefined
  readonly bindings: () => Bindings
  readonly shown: () => Shown
  readonly typing: () => Typing
  readonly companion: () => Companion
  /** Saves what restores the terminal, without its screen. */
  readonly save: (record: Record) => void
  /** Whether `agent` is connected; false without one, or when that cannot be told. */
  readonly connected: (agent: AgentName | undefined) => Promise<boolean>
  /** Windows' process trees, which tell whether a bound agent's pid was reused. */
  readonly trees: () => ProcessTrees
  /** The platform harnesses run their hooks on. */
  readonly platform: () => NodeJS.Platform
}

/**
 * The hooks' reports and asks of each terminal's agents, taken in the order they came: what
 * session each binds, the facts it applies, the root session it follows and what that root
 * worked on, and, for an ask, what its hook prints.
 */
export class Reports {
  /** Each terminal's agent reports and asks waiting their turn, in the order they came. */
  readonly queues = new Map<string, Promise<void>>()
  /** How many times each harness was disconnected, so a report that waited meanwhile is dropped. */
  readonly disconnections = new Map<AgentName, number>()

  constructor(readonly host: ReportsHost) {}

  /** The harness was disconnected: a report of it that waited meanwhile is dropped. */
  disconnected(agent: AgentName): void {
    this.disconnections.set(agent, (this.disconnections.get(agent) ?? 0) + 1)
  }

  /**
   * Runs a terminal's report or ask once its earlier ones are done, in the order they
   * came, as a report may wait for the platform to tell who holds the foreground; other
   * terminals' never hold it up. A failure gives `fallback`.
   */
  queue<T>(terminalId: string, work: () => Promise<T>, fallback: T): Promise<T> {
    const result = (this.queues.get(terminalId) ?? Promise.resolve())
      .then(work)
      .catch(failed.report(fallback))
    const tail = result.then(() => {})
    this.queues.set(terminalId, tail)
    void tail.then(() => {
      if (this.queues.get(terminalId) === tail) this.queues.delete(terminalId)
    })
    return result
  }

  queueReport(report: Report): void {
    void this.queue(report.terminalId, () => this.report(report), undefined)
  }

  /** A Stop or prompt-time hook's ask: its report, then what it prints (see `Messaging.ask`). */
  queueAsk(report: Report, deadline: number): Promise<HookAnswer> {
    const silent = {
      leaseId: null,
      stdout: silentFor(harnesses[report.agent].messaging, report.event),
    }
    return this.queue(report.terminalId, () => this.report(report, deadline), silent)
  }

  /**
   * A harness hook reported; its harness decodes it, and `observe` decides whether each
   * session it names is this terminal's own and the latest, and what it changes. A report
   * that names no session needs neither the foreground nor the harness's connection. An
   * ask, with its hook's `deadline`, then hears what its hook prints.
   */
  async report(report: Report, deadline?: number): Promise<HookAnswer> {
    const silent = {
      leaseId: null,
      stdout: silentFor(harnesses[report.agent].messaging, report.event),
    }
    const record = this.host.records().get(report.terminalId)
    if (!record || record.terminal.exiting || !sameToken(record.token, report.token)) return silent
    const decoded = firedFacts(harnesses[report.agent].decode(report), report)
    // A turn's end its hook named no reply for reads the reply from the agent's
    // transcript; any other report goes on at once.
    const events =
      unreplied(decoded) < 0
        ? decoded
        : await withReplies(
            decoded,
            harnesses[report.agent].transcripts?.items,
            record.bound?.binding.agent === report.agent
              ? { sessionId: record.bound.binding.sessionId, transcript: record.transcript }
              : undefined,
          )
    // Its prompt shows before any session of its binds, as Antigravity's status line says.
    const promptShown = harnesses[report.agent].shown?.(report)
    const shown = promptShown && firedFacts([promptShown], report)[0]
    if (events.length === 0 && !shown) return silent
    const child = record.terminal.pty
    const disconnections = this.disconnections.get(report.agent)
    const observes =
      shown !== undefined || events.some((event) => event.type === "session-observed")
    const [foreground, connected, reused] = observes
      ? await Promise.all([
          shellInForeground(child.pid),
          this.host.connected(report.agent),
          this.reusedBinding(record, events, deadline),
        ])
      : [undefined, true, undefined]
    if (record.terminal.pty !== child || record.terminal.exiting) return silent
    // A disconnection while this waited forgot what the report would bring back.
    if (this.disconnections.get(report.agent) !== disconnections) return silent
    // The bound agent process may have exited without the shell showing a prompt, as in
    // tmux or a nested shell: its binding ended with it, and a later process may bind.
    let changed = false
    if (reused !== undefined && record.bound?.binding === reused) {
      record.left = reused
      this.host.bindings().endLead(record)
      this.host.bindings().endBinding(record)
    } else this.host.bindings().endExited(record)
    const facts = {
      promptedAt: record.promptedAt,
      shellInForeground: foreground,
      submitted: record.submitted,
      connected,
      busy:
        record.bound !== null &&
        (record.bound.activity.state === "working" || record.bound.activity.background !== null),
      platform: process.platform,
    }
    // Its prompt shows, as the agent holding the terminal tells, as for a session it names;
    // one whose hooks its harness says don't run there can take no message.
    if (shown && foreground !== true && (process.platform !== "win32" || record.submitted)) {
      const trust = await this.host.shown().promptTrust(record, report.agent)
      if (record.terminal.pty === child && shown.startedAt > (record.promptedAt ?? 0)) {
        if (trust === "counts") this.host.shown().showPrompt(record, shown)
        else if (trust === "untrusted")
          this.host.messaging().untrusted(record.summary.id, report.agent)
      }
    }
    if (events.length === 0) return silent
    const cwd = record.summary.cwd
    // Every fact applies before messaging sees the report: a turn's start clears the
    // requests waiting on the person, and `askedCleared` must reach messaging before that
    // turn's prompt does, so a draft typed while asked counts before the person's Enter
    // could take the prompt as theirs (pinned by the integration test "applies a draft
    // typed while asked before the prompt that clears the request").
    for (const event of events) {
      if (event.type !== "session-observed") {
        this.host.bindings().applyFact(record, event)
        continue
      }
      if (this.late(record, event)) continue
      // The bound session's transcript, from a later report when the one that bound it
      // named none, as Antigravity's status line does.
      const binding = record.bound?.binding
      if (
        event.transcript !== undefined &&
        record.transcript === null &&
        binding?.agent === event.agent &&
        binding.sessionId === event.sessionId
      )
        record.transcript = event.transcript
      const next = observe(
        {
          sessions: record.agents,
          binding: record.bound?.binding ?? null,
          cwd: record.summary.cwd,
        },
        event,
        facts,
      )
      if (!next) continue
      const before = record.bound
      record.agents = next.sessions
      // A newly bound session waits for its first prompt; one still bound keeps its activity.
      // What its hooks told from before it bound is past, but for one fired with the hook
      // that bound it (see `boundTogetherMs`). Whatever runs from here, as a lead ended
      // below, sees the new binding with its own activity.
      const same =
        before !== null &&
        next.binding !== null &&
        before.binding.agent === next.binding.agent &&
        before.binding.sessionId === next.binding.sessionId
      record.bound =
        next.binding === null
          ? null
          : before !== null && same
            ? { ...before, binding: next.binding }
            : {
                binding: next.binding,
                activity: fresh(
                  boundSince(event),
                  harnesses[next.binding.agent].wakes,
                  harnesses[next.binding.agent].records,
                ),
                telemetry: null,
              }
      if (next.binding !== null) {
        // After a suspended agent, a binding is that agent back from `fg`, or another the
        // person started at the prompt, which its lead never directed.
        if (record.suspended !== null && next.binding.instance !== record.suspended)
          this.host.bindings().endLead(record)
        record.suspended = null
        boundProgram(record, next.binding.agent)
      }
      changed = true
      if (!same) {
        this.host.bindings().follow(record, event)
        // The plans its bar mirrored of another session go; unbinding alone keeps them.
        if (next.binding) this.host.companion().bound(record.summary.id, next.binding.sessionId)
      }
      record.summary = { ...record.summary, cwd: next.cwd }
    }
    // A Stop Novadeck may continue shows once its ask is answered, so a continued turn
    // never flashes idle.
    const stopAsk =
      deadline !== undefined && harnesses[report.agent].messaging.asks[report.event] === "stop"
    const moved = record.summary.cwd !== cwd
    if (!stopAsk) this.host.bindings().publishAgent(record, moved)
    const changes = this.followRootOf(record, events, report.event === "StatusLine")
    const told = await this.attributed(record, events)
    // What the root worked on, from its prompts as told, as Antigravity's from its
    // transcript; this terminal's later reports wait for this one.
    if (this.tallyWork(record, told, changes) || changed) this.host.save(record)
    // The harness compacted the root session's context: it may have lost the notice of its bar.
    if (
      events.some(
        (event) =>
          event.type === "session-observed" && event.compacted && rootedIn(record.root, event),
      )
    )
      record.nudges = fired(record.nudges, "compaction")
    this.host.murmur()?.reported(report.terminalId)
    // The person's own prompt starting a root turn takes the session's open asks out of the
    // Inbox, as delivery judges the prompt theirs, but only with the notice in an answer of
    // the hook that can still print it (see `Messaging.withdrawn`).
    const person: Person = {
      counts: ({ prompt }) => !this.byCommand(record, prompt),
      withdraw: (before) => this.host.asks().withdrawBefore(record.summary.id, before),
      // Kept with its work, so a restart still knows the agent's done was before it.
      prompted: (at) => {
        if (!record.work) return
        record.work = personPrompted(record.work, at)
        this.host.save(record)
      },
    }
    if (deadline === undefined) {
      this.host.messaging().observe(report.terminalId, told, person)
      this.host.bindings().escaped(record)
      this.judgeFirst(record)
      return silent
    }
    const answer = this.host.messaging().ask(report.terminalId, {
      agent: report.agent,
      event: report.event,
      events: told,
      deadline,
      person,
    })
    if (stopAsk) {
      this.continued(record, told, answer)
      this.host.bindings().publishAgent(record, moved)
    }
    this.host.bindings().escaped(record)
    this.judgeFirst(record)
    return this.nudged(record, report, told, answer, deadline)
  }

  /** A Stop Novadeck continued, lapsed as delivery took it, ends the agent's turn too. */
  lapsed(record: Record): void {
    const { bound } = record
    const event =
      bound && this.host.messaging().lapsed(record.summary.id, bound.binding, bound.activity.turnAt)
    if (event && this.host.bindings().applyFact(record, event))
      this.host.bindings().publishAgent(record, false)
  }

  /**
   * A root Stop Novadeck continued with messages, its hook's answer leasing them: the
   * agent's turn goes on, as delivery's does, until the continuation's own Stop.
   */
  continued(record: Record, events: readonly HarnessEvent[], answer: HookAnswer): void {
    if (answer.leaseId === null) return
    const stop = events.find(
      (event) =>
        event.type === "turn-ended" &&
        event.outcome === "completed" &&
        rootedIn(record.root, event),
    )
    if (!stop || stop.type !== "turn-ended") return
    const { agent, sessionId, instance, startedAt } = stop
    this.host.bindings().applyFact(record, {
      type: "turn-continued",
      agent,
      sessionId,
      instance,
      startedAt,
    })
  }

  /**
   * Tells whose the root session's first prompt is, once delivery has taken its turn:
   * the person's own submission, or not, as an agent's command-line prompt.
   */
  judgeFirst(record: Record): void {
    const { work } = record
    if (!work?.first || work.firstByPerson !== undefined) return
    const prompt = this.host.messaging().personPrompt(record.summary.id)
    record.work = judgedFirst(work, prompt !== undefined && !this.byCommand(record, prompt))
    this.host.save(record)
  }

  /**
   * Whether the root session's first prompt, not yet judged, is its opener's own
   * command-line prompt, never the person's whatever Enter came before.
   */
  byCommand(record: Record, prompt: string | undefined): boolean {
    const { work } = record
    return (
      !!work?.first &&
      work.firstByPerson === undefined &&
      work.opened === true &&
      prompt !== undefined &&
      record.openerCommand !== null &&
      promptIn(record.openerCommand, prompt)
    )
  }

  /**
   * A prompt-time hook's answer, with Novadeck's notices when any is due (see
   * `nudges.ts`): the bar beside the terminal and the Inbox, for a session that begins or
   * lost its context, which a `summarize` never clears, and a nudge to summarize the terminal's
   * work, when a trigger fired since the last `summarize`; only at the person's prompt, as
   * a paragraph each, never in an answer that carries messages or another notice, nor at
   * Stop. Each of the person's prompts counts toward the backstop, and where nothing else
   * is said, whether the work drifted is looked at.
   */
  async nudged(
    record: Record,
    report: Report,
    events: readonly HarnessEvent[],
    answer: HookAnswer,
    deadline: number,
  ): Promise<HookAnswer> {
    const { messaging } = harnesses[report.agent]
    if (messaging.asks[report.event] !== "prompt") return answer
    const prompt = events.some(
      (event) =>
        event.type === "turn-started" && event.cause === "prompt" && rootedIn(record.root, event),
    )
    if (!prompt) return answer
    const silent = answer.leaseId === null && answer.stdout === silentFor(messaging, report.event)
    const inTime = (ms: number) => deadline - Date.now() >= ms
    // Read only for an answer that has nothing else to say, so a delivery never waits on
    // it, and only with time to spare.
    const facts =
      silent && record.nudges.baseline && inTime(driftReadMs)
        ? await this.host.peers().facts(peerOf(record))
        : undefined
    // A nudge that may miss the hook's deadline is never spent: its trigger waits.
    const current = { summary: record.naming.summary }
    const printed = (took: Parameters<typeof noticesAt>[0]) =>
      messaging.prompt(noticesAt(took, current))
    const taken = atPrompt(record.nudges, {
      quiet: silent && inTime(leaseMargin),
      facts,
      unsummarized: current.summary === null,
      // Pages the hook may not print in full wait for the next prompt.
      fits: (took) => byteLength(printed(took)) <= maxDeliveryBytes,
    })
    record.nudges = taken.nudges
    if (!taken.nudge) return answer
    return { leaseId: null, stdout: printed(taken) }
  }

  /**
   * Follows the terminal's root session after its binding changed or a report's facts,
   * as its harness's profile says, telling messaging how it changed, and tallies what the
   * root worked on; true when that work changed, to be saved.
   */
  trackRoot(record: Record, events: readonly HarnessEvent[], statusLine: boolean): boolean {
    const changes = this.followRootOf(record, events, statusLine)
    const tallied = this.tallyWork(record, events, changes)
    this.host.murmur()?.reported(record.summary.id)
    return tallied
  }

  /**
   * Follows the terminal's root session after its binding changed or a report's facts, as
   * its harness's profile says, telling messaging how it changed; how it changed.
   */
  followRootOf(
    record: Record,
    events: readonly HarnessEvent[],
    statusLine: boolean,
  ): readonly RootChange[] {
    const { id } = record.summary
    const binding = record.bound?.binding ?? null
    const agent = binding?.agent ?? record.root?.agent
    const { root, changes } = followRoot(record.root, binding, events, {
      mode: agent ? harnesses[agent].messaging.root : "binding",
      statusLine,
      awaited: (sessionId) => this.host.messaging().awaits(id, sessionId),
    })
    record.root = root
    if (changes.length > 0) {
      this.host.messaging().rooted(id, changes)
      this.host.asks().rooted(id, changes)
      this.host.typing().settleBox(record)
    }
    // A new root session has yet to hear of the bar beside its terminal.
    if (changes.some((change) => change.type === "new")) {
      record.nudges = sessionBegan(record.nudges, Date.now())
      if (record.root)
        tellInterrupted(
          record,
          record.root.agent,
          { sessionId: record.root.sessionId },
          this.host.messaging(),
        )
    }
    return changes
  }

  /**
   * Tallies what the root worked on from a report's facts, after its root `changes`;
   * true when that work changed, to be saved. The first session after an agent opened the
   * terminal is marked, as its first prompt may be that agent's command.
   */
  tallyWork(
    record: Record,
    events: readonly HarnessEvent[],
    changes: readonly RootChange[],
  ): boolean {
    const after = workAfter(record.work, record.root, events, Date.now(), changes)
    if (after === record.work) return false
    const started = after !== null && after.session !== record.work?.session
    const work = started && record.awaitsOpened ? { ...after, opened: true as const } : after
    if (started) record.awaitsOpened = false
    record.work = work
    return true
  }

  /**
   * The facts with a root turn's prompt told from the agent's transcript, where its
   * harness's hooks name none (see `typedPromptStart`), remembering what was seen there.
   */
  async attributed(
    record: Record,
    events: readonly HarnessEvent[],
  ): Promise<readonly HarnessEvent[]> {
    const { id } = record.summary
    const { root, transcript } = record
    const typedEntry = root && harnesses[root.agent].messaging.typedEntry
    if (!root || !typedEntry || !transcript) return events
    // The person's Enter, judged by when the turn's hook fired, as delivery judges it.
    const started = events.find((event) => event.type === "turn-started")
    const told = await typedPromptStart(
      events,
      {
        root,
        typedEntry,
        transcript,
        // What was seen of this transcript, not another's.
        seen: record.seenEntry?.transcript === transcript ? record.seenEntry.id : undefined,
        enteredAt:
          started &&
          this.host.messaging().pendingSubmission(id, started.startedAt, started.firedAt),
        ringing: this.host.messaging().ringing(id),
        startedWith: record.startedWith,
      },
      undefined,
      { waitMs: transcriptWaitMs(this.host.platform()) },
    )
    if (told.seen !== undefined) record.seenEntry = { transcript, id: told.seen }
    return told.events
  }

  /** Follows the root after the terminal's binding changed outside its hooks' reports. */
  rebound(record: Record): void {
    this.trackRoot(record, [], false)
  }

  /**
   * A Windows pid can already name another process when the next agent reports. Only
   * a known start after the bound session was observed proves that reuse: an unknown
   * tree, a missing root or an older process leaves the nested-agent gate intact.
   */
  async reusedBinding(
    record: Record,
    events: readonly HarnessEvent[],
    deadline?: number,
  ): Promise<Binding | undefined> {
    const binding = record.bound?.binding
    if (this.host.platform() !== "win32" || !binding?.instance) return undefined
    if (
      !events.some(
        (event) =>
          event.type === "session-observed" &&
          event.instance !== null &&
          (event.agent !== binding.agent ||
            event.instance !== binding.instance ||
            (event.evidence === "startup" && event.sessionId !== binding.sessionId)),
      )
    )
      return undefined
    // A late old hook can move this forward and hide reuse; it cannot prove a live
    // original process is newer than its own hook.
    const observed = record.agents[binding.agent]?.seq
    if (observed === undefined) return undefined
    // Leave an asking hook time to print its answer; a report has the relay's normal bound.
    const timeoutMs =
      deadline === undefined ? relayMs : Math.min(relayMs, deadline - Date.now() - 500)
    if (timeoutMs <= 0) return undefined
    const pid = Number(binding.instance)
    const members = await this.host.trees().read(pid, timeoutMs)
    const root = members?.find((member) => member.pid === pid)
    // The two wall-clock samples may round differently; close starts prove nothing.
    return root !== undefined && root.startedAt > observed + 50 ? binding : undefined
  }

  /** Whether an observation is a late one of the session whose process was found gone. */
  late(record: Record, event: SessionObserved): boolean {
    const { left } = record
    return (
      left !== undefined &&
      left.agent === event.agent &&
      left.sessionId === event.sessionId &&
      (event.instance === null || event.instance === left.instance)
    )
  }
}
