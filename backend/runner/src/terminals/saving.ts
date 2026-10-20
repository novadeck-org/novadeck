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
  readonly input: TranscriptInput
  /** The `keep` setting it was taken under; a later one makes its result stale. */
  readonly epoch: number
  readonly abort: AbortController
  /** Taken for the last pass as the runner shuts down, which may write while it stops. */
  readonly last: boolean
}

/**
 * Saves terminals to the runner's records, so they can be restored, and reads them back:
 * every read and write of the records goes through `persisting`, so none outlives the
 * runner's stop and a failure is logged rather than thrown.
 *
 * A terminal's other state is saved within `saveMs` of a change, as it happens. Its
 * transcript, the screen and scrollback, goes through the redactor first, which masks what
 * looks like a secret, and is saved at most every `transcriptMs`, and at once as its shell
 * exits or restarts; one redaction runs at a time, for the whole runner. A transcript is
 * never saved unredacted: when it cannot be redacted, the copy saved before stays, and the
 * next try waits longer each time. A result that arrives after its terminal was closed, the
 * transcripts were turned off or the runner stopped is dropped.
 */
export class Saves {
  private kept: boolean
  private saver: ReturnType<typeof setInterval> | undefined
  // Counts the changes of `keep`, so a redaction begun before one is not written after it.
  private epoch = 0
  private readonly states = new WeakMap<SavedRecord, TranscriptState>()
  // The terminals whose transcripts wait their turn, and whether each is to go first.
  private readonly waiting = new Map<SavedRecord, boolean>()
  private flight: Job | undefined
  private finishing: Promise<void> | undefined

  constructor(
    private readonly options: SavesOptions,
    readonly host: SavesHost,
  ) {
    this.kept = options.transcripts
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
    for (const record of this.host.records()) if (record.changed) this.save(record, false)
    void this.finish()
  }

  /** Saves what `persist` does, and ends once the transcripts have had their time; then closes the redactor. */
  async shutdown(): Promise<void> {
    for (const record of this.host.records()) if (record.changed) this.save(record, false)
    await this.finish()
    await this.options.redactor?.close()
  }

  /** Turning transcripts off forgets every saved one; turning them on saves each anew. */
  keep(enabled: boolean): void {
    this.kept = enabled
    this.epoch++
    this.waiting.clear()
    this.flight?.abort.abort()
    if (enabled) for (const record of this.host.records()) record.changed = true
    if (!enabled) this.persisting(() => this.options.records?.clearTranscripts())
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
      record.savedAt = now
      this.save(record, false)
      // Without transcripts there is nothing more to wait for.
      if (!this.kept) record.changed = false
    }
    if (!this.kept) return
    for (const record of this.host.records()) {
      const state = this.states.get(record)
      if (
        record.changed &&
        (!state || (now >= state.retryAt && now - state.taken >= this.options.transcriptMs))
      ) {
        this.waiting.set(record, this.waiting.get(record) ?? false)
      }
    }
    this.pump()
  }

  /**
   * Saves what restores the terminal. With `transcript` its screen follows at once, as the
   * shell ended or restarted; otherwise the screen is saved on its usual turn. Nothing is
   * saved once the runner is stopping, or for a terminal that was closed.
   */
  save(record: SavedRecord, transcript: boolean): void {
    // A closed terminal is forgotten for good: work still suspended for it, as an agent's
    // report, must not save it back. An evicted one is kept saved, and still saves.
    if (record.closed) return
    // The transcript is left as it is: only the redactor's result replaces it.
    const saved = this.persisting(() => this.options.records?.saveTerminal(this.row(record)))
    if (!transcript || !saved) return
    if (!this.kept) record.changed = false
    else if (this.options.records) {
      record.changed = true
      this.waiting.set(record, true)
      this.pump()
    }
  }

  /** Takes the next waiting terminal's screen to redact, unless one is in flight already. */
  private pump(): void {
    if (this.flight || this.finishing || !this.kept || !this.options.redactor) return
    if (this.host.stopping() || this.host.stopped()) return
    let next: SavedRecord | undefined
    for (const [record, urgent] of this.waiting) {
      if (record.closed) this.waiting.delete(record)
      else if (urgent) {
        next = record
        break
      } else if (!next || this.state(record).taken < this.state(next).taken) next = record
    }
    if (!next) return
    this.waiting.delete(next)
    const job = this.take(next, false)
    this.flight = job
    void this.run(job).finally(() => {
      this.flight = undefined
      this.pump()
    })
  }

  private state(record: SavedRecord): TranscriptState {
    let state = this.states.get(record)
    if (!state) {
      state = { taken: -Infinity, failures: 0, retryAt: 0 }
      this.states.set(record, state)
    }
    return state
  }

  /** The screen as it is now, marked as taken: a draw after it marks the terminal changed again. */
  private take(record: SavedRecord, last: boolean): Job {
    const screen = record.terminal.screen
    record.changed = false
    this.state(record).taken = performance.now()
    return {
      record,
      input: {
        text: transcriptOf(screen, this.options.transcriptChars) ?? "",
        cols: screen.cols,
        rows: screen.rows,
        lines: screen.buffer.normal.length,
        maxChars: this.options.transcriptChars,
      },
      epoch: this.epoch,
      abort: new AbortController(),
      last,
    }
  }

  /** Redacts a taken screen and writes it, unless it went stale on the way. */
  private async run(job: Job): Promise<void> {
    const { record } = job
    let redacted: string | null | undefined
    try {
      redacted = await this.options.redactor?.redact(job.input, job.abort.signal)
    } catch (error) {
      log.error("terminals.redact-failed", "Novadeck could not redact a transcript", { err: error })
      redacted = null
    }
    // Whatever is not written leaves the terminal changed, so a later turn takes its screen.
    if (redacted === undefined || !this.current(job)) {
      record.changed = true
      return
    }
    const state = this.state(record)
    if (redacted === null) {
      // The screen stays unsaved, and the copy before it stays; the wait grows with each failure.
      record.changed = true
      state.failures++
      const wait = Math.min(2 ** state.failures, longestBackoff) * this.options.transcriptMs
      state.retryAt = performance.now() + wait
      log.warn(
        "terminals.transcript-unredacted",
        "Novadeck could not mask a transcript, so kept the earlier copy",
        {
          data: { terminalId: record.summary.id, retryMs: wait },
        },
      )
      return
    }
    state.failures = 0
    state.retryAt = 0
    const transcript = redacted
    const saved = this.persisting(
      () => this.options.records?.saveTerminal({ ...this.row(record), transcript }),
      "untilStopped",
    )
    if (!saved) record.changed = true
  }

  /** Whether a result is still wanted: nothing closed, turned off or stopped since it was taken. */
  private current(job: Job): boolean {
    return (
      job.epoch === this.epoch &&
      !job.abort.signal.aborted &&
      this.kept &&
      !job.record.closed &&
      !this.host.stopped() &&
      (job.last || !this.host.stopping())
    )
  }

  /**
   * Gives the changed terminals' transcripts one short pass, as the runner shuts down or
   * the system does: screens taken now are redacted one after another for at most
   * `shutdownMs`, and what isn't done keeps its last saved copy. Calls during a pass share it.
   */
  finish(): Promise<void> {
    this.finishing ??= this.last().finally(() => {
      this.finishing = undefined
      this.pump()
    })
    return this.finishing
  }

  private async last(): Promise<void> {
    if (!this.kept || !this.options.records || !this.options.redactor) return
    const redactor = this.options.redactor
    // A redaction in flight is given up, its terminal taken again below.
    if (this.flight) {
      this.flight.record.changed = true
      this.flight.abort.abort()
    }
    this.waiting.clear()
    const jobs: Job[] = []
    for (const record of this.host.records()) {
      if (record.changed && !record.closed) jobs.push(this.take(record, true))
    }
    if (jobs.length === 0) return
    const over = new AbortController()
    const timer = setTimeout(() => over.abort(), this.options.shutdownMs)
    const ended = new Promise<undefined>((resolve) =>
      over.signal.addEventListener("abort", () => resolve(undefined), { once: true }),
    )
    const written = new Set<Job>()
    try {
      for (const job of jobs) {
        if (over.signal.aborted) break
        over.signal.addEventListener("abort", () => job.abort.abort(), { once: true })
        let redacted: string | null | undefined
        try {
          // eslint-disable-next-line no-await-in-loop -- One at a time: the redactor has one thread.
          redacted = await Promise.race([redactor.redact(job.input, job.abort.signal), ended])
        } catch (error) {
          log.error("terminals.redact-failed", "Novadeck could not redact a transcript", {
            err: error,
          })
          redacted = null
        }
        if (typeof redacted !== "string" || !this.current(job)) continue
        const transcript = redacted
        const saved = this.persisting(
          () => this.options.records?.saveTerminal({ ...this.row(job.record), transcript }),
          "untilStopped",
        )
        if (saved) written.add(job)
      }
    } finally {
      clearTimeout(timer)
      over.abort()
      // What wasn't written is still changed, and keeps its last saved copy.
      for (const job of jobs) if (!written.has(job)) job.record.changed = true
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
    this.persisting(() => this.options.records?.removeTerminal(terminalId), "untilStopped")
  }

  /**
   * Runs a write to the records, unless the runner is stopping, or with "untilStopped" a
   * read or removal until it has stopped; a failure is logged. True once it is done, or
   * when there are no records.
   */
  persisting(work: () => void, until: "untilStopped" | "untilStopping" = "untilStopping"): boolean {
    if (!this.options.records) return true
    if (until === "untilStopping" ? this.host.stopping() : this.host.stopped()) return false
    try {
      work()
      return true
    } catch (error) {
      log.error("terminals.save-failed", "Novadeck could not save a terminal", { err: error })
      return false
    }
  }
}
