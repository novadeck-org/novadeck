import { DomainError } from "../errors.js"
import { nextHandle, wordOf } from "./handles.js"
import { renamed as renamedTo, summaryTitle } from "./naming.js"
import type { SavedRecord, Saves } from "./saving.js"
import type { Streams } from "./streams.js"
import { savedSummaryOf } from "./summary.js"

/** What naming reads of a terminal's record, and what it changes there. */
export type NamedRecord = SavedRecord

export type NamesHost<R extends NamedRecord> = {
  /** The runner is stopping: no terminal is given a handle. */
  readonly stopping: () => boolean
  /** Every terminal the runner holds. */
  readonly records: () => Iterable<R>
  /** The terminal the runner holds by that id, running or retained. */
  readonly record: (terminalId: string) => R | undefined
  /** Reports the record's current summary to every watcher. */
  readonly announce: (record: R) => void
}

/**
 * Names terminals: the handle each session gives its next terminal, and the title the
 * person gives one, running or saved (see `titleOf`).
 */
export class Names<R extends NamedRecord> {
  /** The handles each session has given, without records to keep them. */
  private readonly handles = new Map<string, ReadonlySet<string>>()

  constructor(
    /** Whether the runner keeps records, which then give handles. */
    private readonly recorded: boolean,
    private readonly saves: Saves,
    private readonly streams: Streams<R>,
    readonly host: NamesHost<R>,
  ) {}

  /**
   * The handle a session gives its next terminal, never one it gave before: from its
   * records when the runner keeps them, else counted in memory. When the records can't
   * give one, no terminal is created, since a handle chosen afresh could repeat one.
   */
  next(sessionId: string): string {
    if (!this.recorded) {
      const given = this.handles.get(sessionId) ?? new Set<string>()
      const live = [...this.host.records()]
        .filter((record) => !record.closed)
        .map((record) => record.summary)
      const handle = nextHandle(
        {
          given,
          open: live
            .filter((summary) => summary.sessionId === sessionId)
            .map((summary) => summary.handle),
        },
        new Set(
          live
            .filter((summary) => summary.sessionId !== sessionId)
            .map((summary) => wordOf(summary.handle)),
        ),
      )
      this.handles.set(sessionId, new Set(given).add(handle))
      return handle
    }
    const handle = this.saves.giveHandle(sessionId)
    if (this.host.stopping()) throw new DomainError("CLOSING")
    if (handle === undefined)
      throw new Error(
        "Novadeck couldn't give a new terminal a handle in its workspace database, so it didn't create it.",
      )
    return handle
  }

  /** Where a handle comes in the order its session gave handles in memory; -1 if it gave none. */
  order(sessionId: string, handle: string): number {
    return [...(this.handles.get(sessionId) ?? [])].indexOf(handle)
  }

  /** Forgets the handles a session gave in memory, as its project goes. */
  forgetSession(sessionId: string): void {
    this.handles.delete(sessionId)
  }

  /** Gives a terminal the person's title, or with null takes it away, telling every watcher. */
  name(terminalId: string, title: string | null): void {
    const record = this.host.record(terminalId)
    if (record) {
      record.naming = renamedTo(record.naming, title)
      // Watchers hear of a rename even to the title it already had.
      if (!this.retitle(record)) this.host.announce(record)
      this.saves.save(record, false)
      return
    }
    const renamed = this.saves.rename(terminalId, title)
    const saved = renamed ? this.saves.saved(terminalId) : undefined
    if (!saved) throw new DomainError("TERMINAL_NOT_FOUND")
    this.streams.changed(() => savedSummaryOf(saved))
  }

  /**
   * The terminal's title after what names it changed (see `titleOf`), announced when it
   * differs, as the answer says; the caller saves it.
   */
  retitle(record: R): boolean {
    const titled = summaryTitle(record.naming, record.summary)
    const { title, titleSource } = record.summary
    if (
      titled.title === title &&
      JSON.stringify(titled.titleSource) === JSON.stringify(titleSource)
    )
      return false
    record.summary = { ...record.summary, ...titled }
    this.host.announce(record)
    return true
  }
}
