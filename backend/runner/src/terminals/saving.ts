import { transcript as transcriptOf } from "@novadeck/emulator/headless"
import type { AgentName } from "@novadeck/protocol"

import type { Record } from "./record.js"
import type { ListedTerminal, SavedTerminal, TerminalIdentity, TerminalRecords } from "./records.js"

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
  /** How often changed terminals are saved, in milliseconds. */
  readonly saveMs: number
  /** The longest transcript kept per terminal, in characters. */
  readonly transcriptChars: number
  /** Whether terminals' transcripts are kept, until `keep` changes it. */
  readonly transcripts: boolean
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

/**
 * Saves terminals to the runner's records, so they can be restored, and reads them back:
 * every read and write of the records goes through `persisting`, so none outlives the
 * runner's stop and a failure is logged rather than thrown.
 */
export class Saves {
  /** Whether terminals' transcripts are kept, until `keep` changes it. */
  transcripts: boolean
  private saver: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly options: SavesOptions,
    readonly host: SavesHost,
  ) {
    this.transcripts = options.transcripts
  }

  /** Saves every terminal's changes now, as before the system shuts down. */
  persist(): void {
    for (const record of this.host.records()) if (record.changed) this.save(record, true)
  }

  /** Turning transcripts off forgets every saved one; turning them on saves each anew. */
  keep(enabled: boolean): void {
    this.transcripts = enabled
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
  }

  /**
   * Saves a few changed terminals whose screens were saved longest ago, so the runner
   * never stops for all of them at once; each is saved every `saveMs` or so.
   */
  private persistSome(): void {
    const due = performance.now() - this.options.saveMs
    const waiting = [...this.host.records()]
      .filter((record) => record.changed && record.savedAt <= due)
      .toSorted((a, b) => a.savedAt - b.savedAt)
    for (const record of waiting.slice(0, savesPerTick)) this.save(record, true)
  }

  /**
   * Saves what restores the terminal, and with `transcript` its screen too. Nothing is
   * saved once the runner is stopping, or for a terminal that was closed.
   */
  save(record: SavedRecord, transcript: boolean): void {
    // A closed terminal is forgotten for good: work still suspended for it, as an agent's
    // report, must not save it back. An evicted one is kept saved, and still saves.
    if (record.closed) return
    // A failed save leaves the screen marked changed, so a later one tries again, once
    // `saveMs` has passed.
    if (transcript) record.savedAt = performance.now()
    const saved = this.persisting(() =>
      this.options.records?.saveTerminal({
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
        ...(transcript && {
          transcript: this.transcripts
            ? transcriptOf(record.terminal.screen, this.options.transcriptChars)
            : null,
        }),
      }),
    )
    if (transcript && saved) record.changed = false
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
      console.error("Novadeck could not save a terminal:", error)
      return false
    }
  }
}
