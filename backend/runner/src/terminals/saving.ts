import { transcript as transcriptOf } from "@novadeck/emulator/headless"
import type { AgentName } from "@novadeck/protocol"

import { logs } from "../log.js"
import type { Record } from "./record.js"
import type {
  ListedTerminal,
  SavedTerminal,
  TerminalIdentity,
  TerminalRecords,
  TerminalToSave,
} from "./records.js"
import type { TranscriptRedactor } from "./redaction.js"
import { sealedShape, type TranscriptSealer } from "./sealing.js"
import type { TranscriptInput } from "./transcriptRedaction.js"

const log = logs.for("terminals")

/** What saving reads of a terminal's record, and the two fields it keeps there. */
export type SavedRecord = Pick<
  Record,
  | "summary"
  | "naming"
  | "openedBy"
  | "work"
  | "agents"
  | "promptedAt"
  | "closed"
  | "terminal"
  | "changed"
  | "screenChanged"
  | "savedAt"
>

export type SavesOptions = {
  /** Where terminals are saved for restoring; unsaved when undefined. */
  readonly records: TerminalRecords | undefined
  /** How often changed terminals' other state is saved, in milliseconds. */
  readonly saveMs: number
  /** How often a changed terminal's transcript is redacted and saved, in milliseconds. */
  readonly transcriptMs: number
  /** How long the last transcripts get as the runner shuts down, in milliseconds. */
  readonly shutdownMs: number
  /** The longest transcript kept per terminal, in characters. */
  readonly transcriptChars: number
  /** Whether terminals' transcripts are kept, until `keep` changes it. */
  readonly transcripts: boolean
  /** Masks the secrets in every transcript before it is saved; none is saved without it. */
  readonly redactor: TranscriptRedactor | undefined
  /** Seals every masked transcript before it is saved; none is saved or shown without it. */
  readonly sealer: TranscriptSealer | undefined
  /** The longest a restored terminal waits for the sealer's key, in milliseconds. */
  readonly keyMs: number
}

export type SavesHost = {
  /** The runner is stopping: nothing is written to the records any more. */
  readonly stopping: () => boolean
  /** The runner has stopped: its records may be closed, and nothing reads or forgets them. */
  readonly stopped: () => boolean
  /** Every terminal the runner holds. */
  readonly records: () => Iterable<SavedRecord>
}

// How many changed terminals one periodic save handles.
const savesPerTick = 4
// The longest wait after a transcript could not be redacted, in multiples of `transcriptMs`.
const longestBackoff = 20

/** What a terminal's transcript has gone through, kept beside its record. */
type TranscriptState = {
  /** When its screen was last taken to be saved. */
  taken: number
  /** How many times in a row it could not be redacted. */
  failures: number
  /** Not taken again before this time, after a failure. */
  retryAt: number
}

/** A screen taken to be redacted and saved. */
type Job = {
  readonly record: SavedRecord
  /** What the redactor is given; null for a screen with nothing on it, which is saved as none. */
  readonly input: TranscriptInput | null
  /** The `keep` setting it was taken under; a later one makes its result stale. */
  readonly epoch: number
  readonly abort: AbortController
  /** Taken for the last pass as the runner shuts down, which may write while it stops. */
  last: boolean
}

/**
 * Saves terminals to the runner's records, so they can be restored, and reads them back:
 * every read and write of the records goes through `persisting`, so none outlives the
 * runner's stop and a failure is logged rather than thrown.
 *
 * A terminal keeps two marks. `changed` means its restoring state (title, directory,
 * agents, prompt) is unsaved: that is saved within `saveMs`, a few terminals a tick.
 * `screenChanged` means its screen is: the transcript, the screen and scrollback, goes
 * through the redactor first, which masks what looks like a secret, and is saved at most
 * every `transcriptMs`. A shell that exits or restarts goes first in the queue, ahead of
 * the usual turns; one redaction runs at a time, for the whole runner. A transcript is
 * never saved unredacted: when it cannot be redacted, the copy saved before stays, and the
 * next try waits longer each time. A masked transcript is sealed (see sealing.ts) just
 * before it is written, and none is taken before the sealer has its key: until then the
 * screens simply stay changed. When there turns out to be none, transcripts are neither
 * saved nor shown for this run, but the ones sealed before are kept. Whatever transcript is
 * saved unsealed is forgotten as the runner starts. A restored terminal whose copy went
 * unopened because the key came too late keeps it for the run. A result that arrives after its
 * terminal was closed, the transcripts were turned off or the runner stopped is dropped. As
 * the runner or the system shuts down, `finish` gives the unsaved screens one pass of
 * `shutdownMs`, which may write until it is over.
 */
export class Saves {
  private kept: boolean
  // Whether the sealer has its key; undefined while that is awaited.
  private key: boolean | undefined
  private saver: ReturnType<typeof setInterval> | undefined
  // Counts the changes of `keep`, so a redaction begun before one is not written after it.
  private epoch = 0
  private readonly states = new WeakMap<SavedRecord, TranscriptState>()
  // The terminals whose transcripts wait their turn, and whether each is to go first.
  private readonly waiting = new Map<SavedRecord, boolean>()
  // The screens taken and not yet settled: one in flight, and the last pass's.
  private readonly taken = new Set<Job>()
  // Ends the wait for the key, for every restore of this run: begun by the first.
  private late: Promise<false> | undefined
  // The terminals whose saved transcript went unopened as the key had not come: it stays
  // as saved for this run, and none is saved over it.
  private readonly unopened = new Set<string>()
  private flight: { readonly job: Job; readonly done: Promise<void> } | undefined
  private finishing: Promise<void> | undefined

  constructor(
    private readonly options: SavesOptions,
    readonly host: SavesHost,
  ) {
    this.kept = options.transcripts
    // Whatever an earlier runner left unsealed is forgotten at once: that needs no key.
    this.persisting(() => options.records?.forgetUnsealed(sealedShape), "untilStopped")
    void (options.sealer?.ready ?? Promise.resolve(false)).then((key) => {
      this.key = key
      if (key) this.pump()
    })
  }

  /** Whether terminals' transcripts are kept, until `keep` changes it. */
  get transcripts(): boolean {
    return this.kept
  }

  /**
   * Saves every terminal's changes now, as before the system shuts down: the other state
   * at once, the transcripts in a short pass behind it (see `finish`) that this doesn't
   * wait for.
   */
  persist(): void {
    this.flush()
    void this.finish()
  }

  /** Saves what `persist` does, and ends once the transcripts have had their time; then closes the redactor. */
  async shutdown(): Promise<void> {
    this.flush()
    await this.finish()
    await this.options.redactor?.close()
  }

  private flush(): void {
    for (const record of this.host.records()) {
      if (record.changed && this.saveRow(record)) record.changed = false
    }
  }

  /**
   * Turning transcripts off forgets every saved one; turning them on saves each anew. Asked
   * for what is already so, nothing changes: a copy left alone is not saved over.
   */
  keep(enabled: boolean): void {
    if (enabled === this.kept) return
    this.kept = enabled
    this.epoch++
    this.waiting.clear()
    this.unopened.clear()
    for (const job of this.taken) job.abort.abort()
    if (enabled) for (const record of this.host.records()) record.screenChanged = true
    if (!enabled) this.persisting(() => this.options.records?.clearTranscripts())
  }

  /**
   * A kept terminal's transcript, opened; null when there is none, transcripts are off, the
   * key does not come within `keyMs` of the first restore (then its saved copy is left
   * alone for this run), or it does not open. Awaited before a restored shell starts, so
   * the replay is queued ahead of its output.
   */
  async open(saved: SavedTerminal): Promise<string | null> {
    const { sealer } = this.options
    if (!saved.transcript || !this.kept || !sealer) return null
    this.late ??= new Promise<false>((resolve) => {
      setTimeout(() => resolve(false), this.options.keyMs).unref()
    })
    const key = await Promise.race([sealer.ready, this.late.then(() => undefined)])
    // Without the key yet it may still come: the copy stays, unsaved over, for this run.
    if (key === undefined) this.unopened.add(saved.id)
    // Opened later, as when restored again, its new screen starts from the copy.
    else if (key) this.unopened.delete(saved.id)
    if (!key || !this.kept) return null
    return sealer.open(saved.transcript, saved.id)
  }

  /** Saves changed terminals every so often, so a runner killed at any moment loses little. */
  start(): void {
    if (this.saver || this.host.stopping() || !this.options.records) return
    this.saver = setInterval(() => this.persistSome(), this.options.saveMs / 5)
    this.saver.unref()
  }

  /** Stops the periodic saves, as the runner shuts down. */
  stop(): void {
    clearInterval(this.saver)
    this.saver = undefined
    this.waiting.clear()
  }

  /**
   * Saves a few changed terminals whose state was saved longest ago, so the runner never
   * stops for all of them at once; each is saved every `saveMs` or so. Then lines up the
   * transcripts that are due.
   */
  private persistSome(): void {
    const now = performance.now()
    const due = now - this.options.saveMs
    const waiting = [...this.host.records()]
      .filter((record) => record.changed && record.savedAt <= due)
      .toSorted((a, b) => a.savedAt - b.savedAt)
    for (const record of waiting.slice(0, savesPerTick)) {
      // A failed save leaves it changed, so a later tick tries again once `saveMs` has passed.
      record.savedAt = now
      if (this.saveRow(record)) record.changed = false
    }
    if (!this.kept || !this.key) return
    for (const record of this.host.records()) {
      const state = this.states.get(record)
      if (
        record.screenChanged &&
        (!state || (now >= state.retryAt && now - state.taken >= this.options.transcriptMs))
      ) {
        this.waiting.set(record, this.waiting.get(record) ?? false)
      }
    }
    this.pump()
  }

  /**
   * Saves what restores the terminal. With `transcript` its screen goes first in the queue
   * to be saved too, as the shell ended or restarted; otherwise the screen is saved on its
   * usual turn. Nothing is saved once the runner is stopping, or for a terminal that was
   * closed.
   */
  save(record: SavedRecord, transcript: boolean): void {
    if (!this.saveRow(record) || !transcript || !this.kept || !this.options.records) return
    record.screenChanged = true
    this.waiting.set(record, true)
    this.pump()
  }

  /** Saves a terminal's restoring state alone, leaving its transcript as it is; whether it was saved. */
  private saveRow(record: SavedRecord): boolean {
    // A closed terminal is forgotten for good: work still suspended for it, as an agent's
    // report, must not save it back. An evicted one is kept saved, and still saves.
    if (record.closed) return false
    return this.persisting(() => this.options.records?.saveTerminal(this.row(record)))
  }

  /** Takes the next waiting terminal's screen to redact, unless one is in flight already. */
  private pump(): void {
    if (this.flight || this.finishing || !this.kept || !this.key || !this.options.redactor) return
    if (this.host.stopping() || this.host.stopped()) return
    let next: SavedRecord | undefined
    for (const [record, urgent] of this.waiting) {
      if (record.closed || this.unopened.has(record.summary.id)) this.waiting.delete(record)
      else if (urgent) {
        next = record
        break
      } else if (!next || this.state(record).taken < this.state(next).taken) next = record
    }
    if (!next) return
    this.waiting.delete(next)
    const job = this.take(next, false)
    const done = this.run(job).finally(() => {
      this.flight = undefined
      this.pump()
    })
    this.flight = { job, done }
  }

  private state(record: SavedRecord): TranscriptState {
    let state = this.states.get(record)
    if (!state) {
      state = { taken: -Infinity, failures: 0, retryAt: 0 }
      this.states.set(record, state)
    }
    return state
  }

  /**
   * The screen as it is now, marked as taken: a draw after it marks the terminal changed
   * again. It is given whole, for the redactor to cut after masking: cut before, a secret's
   * name could go while the tail of its value stayed.
   */
  private take(record: SavedRecord, last: boolean): Job {
    const screen = record.terminal.screen
    record.screenChanged = false
    this.state(record).taken = performance.now()
    const text = transcriptOf(screen, Number.POSITIVE_INFINITY)
    const job: Job = {
      record,
      input: text
        ? {
            text,
            cols: screen.cols,
            rows: screen.rows,
            lines: screen.buffer.normal.length,
            maxChars: this.options.transcriptChars,
          }
        : null,
      epoch: this.epoch,
      abort: new AbortController(),
      last,
    }
    this.taken.add(job)
    return job
  }

  /** Redacts a taken screen: "" for one with nothing on it, null when it could not be, undefined when given up. */
  private async redact(job: Job): Promise<string | null | undefined> {
    if (!job.input) return ""
    try {
      return await this.options.redactor?.redact(job.input, job.abort.signal)
    } catch (error) {
      log.error("terminals.redact-failed", "Novadeck could not redact a transcript", { err: error })
      return null
    }
  }

  private async run(job: Job): Promise<void> {
    this.settle(job, await this.redact(job))
  }

  /** Writes a redacted screen, unless it went stale on the way; whatever isn't written leaves the screen changed. */
  private settle(job: Job, redacted: string | null | undefined): void {
    const { record } = job
    this.taken.delete(job)
    if (redacted === undefined || !this.current(job)) {
      record.screenChanged = true
      return
    }
    const state = this.state(record)
    if (redacted === null) {
      // The screen stays unsaved, and the copy before it stays; the wait grows with each failure.
      record.screenChanged = true
      state.failures++
      const wait = Math.min(2 ** state.failures, longestBackoff) * this.options.transcriptMs
      state.retryAt = performance.now() + wait
      log.warn(
        "terminals.transcript-unredacted",
        "Novadeck could not mask a transcript, so did not save it",
        { data: { terminalId: record.summary.id, retryMs: wait } },
      )
      return
    }
    state.failures = 0
    state.retryAt = 0
    this.write(job, redacted || null)
  }

  private write(job: Job, masked: string | null): void {
    const { record } = job
    const transcript =
      masked === null ? null : (this.options.sealer?.seal(masked, record.summary.id) ?? undefined)
    if (transcript === undefined) {
      record.screenChanged = true
      return
    }
    // The last pass writes until it is over, which is before the records close.
    const saved = this.persisting(
      () => this.options.records?.saveTerminal({ ...this.row(record), transcript }),
      job.last ? "always" : "untilStopped",
    )
    if (!saved) record.screenChanged = true
  }

  /** Whether a result is still wanted: nothing closed, turned off or stopped since it was taken. */
  private current(job: Job): boolean {
    return (
      job.epoch === this.epoch &&
      !job.abort.signal.aborted &&
      this.kept &&
      !job.record.closed &&
      (job.last || (!this.host.stopped() && !this.host.stopping()))
    )
  }

  /**
   * Gives the unsaved screens' transcripts one short pass, as the runner shuts down or the
   * system does: the one in flight is waited for, the others redacted one after another,
   * for at most `shutdownMs` in all, and what isn't done keeps its last saved copy. Calls
   * during a pass share it.
   */
  finish(): Promise<void> {
    this.finishing ??= this.last().finally(() => {
      this.finishing = undefined
      this.pump()
    })
    return this.finishing
  }

  private async last(): Promise<void> {
    if (!this.kept || !this.key || !this.options.records || !this.options.redactor) return
    const flight = this.flight
    // The redaction in flight goes on, and is written like the rest of the pass.
    if (flight) flight.job.last = true
    this.waiting.clear()
    const jobs: Job[] = []
    for (const record of this.host.records()) {
      if (record.screenChanged && !record.closed && !this.unopened.has(record.summary.id))
        jobs.push(this.take(record, true))
    }
    if (!flight && jobs.length === 0) return
    const over = new AbortController()
    const timer = setTimeout(() => over.abort(), this.options.shutdownMs)
    const ended = new Promise<undefined>((resolve) =>
      over.signal.addEventListener("abort", () => resolve(undefined), { once: true }),
    )
    try {
      for (const job of [...(flight ? [flight.job] : []), ...jobs]) {
        if (over.signal.aborted) break
        over.signal.addEventListener("abort", () => job.abort.abort(), { once: true })
        if (job === flight?.job) {
          // eslint-disable-next-line no-await-in-loop -- One at a time: the redactor has one thread.
          await Promise.race([flight.done, ended])
          continue
        }
        // eslint-disable-next-line no-await-in-loop -- One at a time: the redactor has one thread.
        this.settle(job, await Promise.race([this.redact(job), ended]))
      }
    } finally {
      clearTimeout(timer)
      over.abort()
      // What wasn't reached is still changed, and keeps its last saved copy.
      for (const job of jobs) if (this.taken.delete(job)) job.record.screenChanged = true
    }
  }

  /** What restores a terminal, without its transcript. */
  private row(record: SavedRecord): TerminalToSave {
    return {
      id: record.summary.id,
      sessionId: record.summary.sessionId,
      handle: record.summary.handle,
      naming: record.naming,
      openedBy: record.openedBy,
      ledBy: record.summary.ledBy,
      work: record.work,
      command: record.summary.command,
      lastProgram: record.summary.lastProgram,
      cwd: record.summary.cwd,
      agents: record.agents,
      promptedAt: record.promptedAt,
    }
  }

  /** A kept terminal, of `sessionId` when given; read until the runner has stopped. */
  saved(terminalId: string, sessionId?: string): SavedTerminal | undefined {
    let saved: SavedTerminal | undefined
    this.persisting(() => {
      saved = this.options.records?.terminal(terminalId)
    }, "untilStopped")
    return saved && (sessionId === undefined || saved.sessionId === sessionId) ? saved : undefined
  }

  /** A kept terminal's handle, title and who gave it, read alone. */
  identity(terminalId: string): TerminalIdentity | undefined {
    let kept: TerminalIdentity | undefined
    this.persisting(() => {
      kept = this.options.records?.terminalIdentity(terminalId)
    })
    return kept
  }

  /** Every terminal kept, of one session or all, in the order they were created; none on a failure. */
  terminals(sessionId?: string): readonly ListedTerminal[] {
    let kept: readonly ListedTerminal[] = []
    this.persisting(() => {
      kept = this.options.records?.terminals(sessionId) ?? []
    })
    return kept
  }

  /** The handle the records give a session's next terminal; undefined when they can't. */
  giveHandle(sessionId: string): string | undefined {
    let handle: string | undefined
    this.persisting(() => {
      handle = this.options.records?.giveHandle(sessionId)
    })
    return handle
  }

  /** Gives a kept terminal the person's title, or with null takes it away; whether one was kept. */
  rename(terminalId: string, title: string | null): boolean {
    let renamed = false
    this.persisting(() => {
      renamed = this.options.records?.renameTerminal(terminalId, title) ?? false
    })
    return renamed
  }

  /** Takes murmur's title from every kept terminal; the ids it took it from. */
  clearMurmurTitles(): readonly string[] {
    let changed: readonly string[] = []
    this.persisting(() => {
      changed = this.options.records?.clearMurmurTitles() ?? []
    })
    return changed
  }

  /** Forgets every session the agent reported, as once it is disconnected. */
  forgetAgent(agent: AgentName): void {
    this.persisting(() => this.options.records?.forgetAgent(agent))
  }

  /** Forgets a kept terminal; while the runner stops too, as a close then still stands. */
  remove(terminalId: string): void {
    // A screen of it taken or waiting must not save it back.
    this.unopened.delete(terminalId)
    for (const record of this.waiting.keys())
      if (record.summary.id === terminalId) this.waiting.delete(record)
    for (const job of this.taken) if (job.record.summary.id === terminalId) job.abort.abort()
    this.persisting(() => this.options.records?.removeTerminal(terminalId), "untilStopped")
  }

  /**
   * Runs a write to the records, unless the runner is stopping, or with "untilStopped" a
   * read or removal until it has stopped; a failure is logged. True once it is done, or
   * when there are no records.
   */
  persisting(
    work: () => void,
    until: "always" | "untilStopped" | "untilStopping" = "untilStopping",
  ): boolean {
    if (!this.options.records) return true
    if (
      until === "untilStopping"
        ? this.host.stopping()
        : until === "untilStopped" && this.host.stopped()
    ) {
      return false
    }
    try {
      work()
      return true
    } catch (error) {
      log.error("terminals.save-failed", "Novadeck could not save a terminal", { err: error })
      return false
    }
  }
}
