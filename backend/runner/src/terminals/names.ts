import { DomainError } from "../errors.js"
import { claimable, handleCooldown, handleOrder, nextHandle, type PooledHandle } from "./handles.js"
import type { SavedRecord, Saves } from "./saving.js"
import type { Streams } from "./streams.js"
import { renamed as renamedTo, summaryTitle } from "./titles.js"

/** What naming reads of a terminal's record, and what it changes there. */
export type NamedRecord = SavedRecord

export type NamesHost<R extends NamedRecord> = {
  /** The runner is stopping: no terminal is given a handle. */
  readonly stopping: () => boolean
  /** Every terminal the runner holds, a closing one too until its shell has ended. */
  readonly records: () => Iterable<R>
  /** The terminal the runner holds by that id, running or retained. */
  readonly record: (terminalId: string) => R | undefined
  /** The project a session belongs to, or the session itself when that cannot be told. */
  readonly projectOf: (sessionId: string) => string
  /** Reports the record's current summary to every watcher. */
  readonly announce: (record: R) => void
}

/** How the runner names terminals. */
export type NamesOptions = {
  /** Where terminals are saved, which then give handles; counted in memory when omitted. */
  readonly records?: unknown
  /** The order each session gives handle words in: its own shuffle when omitted. */
  readonly handleOrder?: (sessionId: string) => readonly string[]
  /** How long a handle rests after its terminal is gone: an hour when omitted. */
  readonly handleCooldown?: number
}

/** A handle a project gave, counted in memory: what the pool of a runner without records keeps. */
type MemoryHandle = PooledHandle & {
  /** Where it comes in the order the project gave handles. */
  readonly seq: number
  /** When it was given, in epoch milliseconds. */
  readonly at: number
  /** Whether a terminal holds it, as far as the runner has been told or has seen. */
  readonly held: boolean
}

/**
 * Names terminals: the handle a project gives the next terminal of its sessions, and the
 * title the person gives one, running or saved (see `titleOf`).
 */
export class Names<R extends NamedRecord> {
  /** The handles each project has given, without records to keep them. */
  private readonly pools = new Map<string, Map<string, MemoryHandle>>()
  /** How many handles were given in memory, which orders them. */
  private given = 0
  /** The handles the runner's records held when a project last drew or claimed, by project. */
  private readonly seen = new Map<string, ReadonlySet<string>>()

  /** Whether the runner keeps records, which then give handles. */
  private readonly recorded: boolean
  /** The order each session gives handle words in. */
  private readonly wordOrder: (sessionId: string) => readonly string[]
  private readonly cooldown: number

  constructor(
    options: NamesOptions,
    private readonly saves: Saves,
    private readonly streams: Streams<R>,
    readonly host: NamesHost<R>,
  ) {
    this.recorded = Boolean(options.records)
    this.wordOrder = options.handleOrder ?? handleOrder
    this.cooldown = options.handleCooldown ?? handleCooldown
  }

  /**
   * The handles of the project's terminals the runner holds, closed ones too until their
   * shells end: such a terminal still holds its handle. Not that of `except`: the terminal
   * taking its own handle back (a restore of one whose shell is still ending).
   */
  private holding(sessionId: string, except?: string): string[] {
    const project = this.host.projectOf(sessionId)
    return [...this.host.records()]
      .filter((record) => record.summary.id !== except)
      .filter((record) => this.host.projectOf(record.summary.sessionId) === project)
      .map((record) => record.summary.handle)
  }

  /**
   * The handle a project gives the next terminal of a session: one nothing in the project
   * holds, never given before or freed a cooldown ago, from its records when the runner
   * keeps them, else counted in memory. When the records can't give one, no terminal is
   * created, since a handle chosen afresh could repeat one.
   */
  next(sessionId: string): string {
    if (!this.recorded) {
      const project = this.host.projectOf(sessionId)
      const pool = this.pools.get(project) ?? new Map<string, MemoryHandle>()
      const held = this.settle(project, pool, this.holding(sessionId))
      const handle = nextHandle({
        order: this.wordOrder(sessionId),
        pool,
        held,
        open: [...this.host.records()]
          .filter((record) => !record.closed && record.summary.sessionId === sessionId)
          .map((record) => record.summary.handle),
        now: Date.now(),
        cooldown: this.cooldown,
      })
      this.give(project, handle, null)
      return handle
    }
    const handle = this.saves.giveHandle(sessionId, this.wordOrder(sessionId), {
      holding: this.holding(sessionId),
      cooldown: this.cooldown,
    })
    if (this.host.stopping()) throw new DomainError("CLOSING")
    if (handle === undefined)
      throw new Error(
        "Novadeck couldn't give a new terminal a handle in its workspace database, so it didn't create it.",
      )
    return handle
  }

  /**
   * Takes the handle for the terminal, as a restored one takes back its own: false when
   * anything in the project holds it, or another terminal freed it less than a cooldown
   * ago. True holds it for the terminal until `release`.
   */
  claim(sessionId: string, handle: string, terminalId: string): boolean {
    if (this.recorded)
      return this.saves.claimHandle(sessionId, handle, terminalId, {
        holding: this.holding(sessionId, terminalId),
        cooldown: this.cooldown,
      })
    const project = this.host.projectOf(sessionId)
    const pool = this.pools.get(project) ?? new Map<string, MemoryHandle>()
    const held = this.settle(project, pool, this.holding(sessionId, terminalId))
    if (!claimable(handle, { pool, held, now: Date.now(), cooldown: this.cooldown }, terminalId))
      return false
    this.give(project, handle, terminalId, pool.get(handle)?.freedBy === terminalId)
    return true
  }

  /**
   * The terminal no longer holds the handle, because it is gone or took another: it rests
   * a cooldown, then the project may give it again. A handle another terminal of the
   * project holds (made before handles were unique there) stays held. A create that fails
   * releases nothing: its handle rests a cooldown from when it was drawn.
   */
  release(sessionId: string, handle: string, terminalId: string): void {
    if (this.recorded) return this.saves.releaseHandle(sessionId, handle, terminalId)
    const pool = this.pools.get(this.host.projectOf(sessionId))
    const given = pool?.get(handle)
    if (given)
      pool!.set(handle, { ...given, freedAt: Date.now(), freedBy: terminalId, held: false })
  }

  /** When the project gave the handle to its terminal, in epoch milliseconds; 0 where that is not known. */
  givenAt(sessionId: string, handle: string): number {
    if (this.recorded) return this.saves.handleGivenAt(sessionId, handle) ?? 0
    return this.pools.get(this.host.projectOf(sessionId))?.get(handle)?.at ?? 0
  }

  /** Where a handle comes in the order its project gave handles in memory; -1 if it gave none. */
  order(sessionId: string, handle: string): number {
    return this.pools.get(this.host.projectOf(sessionId))?.get(handle)?.seq ?? -1
  }

  /** Forgets the handles a project gave in memory, as it goes. */
  forgetProject(projectId: string): void {
    this.pools.delete(projectId)
    this.seen.delete(projectId)
  }

  /**
   * Notes the handles the project's records hold now. One a record held when last looked at
   * and none holds now belongs to a terminal that exited or was let go without a release
   * (`Terminals.evicted`): it rests from now. Returns the handles held.
   */
  private settle(
    project: string,
    pool: Map<string, MemoryHandle>,
    holding: readonly string[],
  ): Set<string> {
    const held = new Set(holding)
    for (const handle of this.seen.get(project) ?? []) {
      const entry = pool.get(handle)
      if (!held.has(handle) && entry?.held)
        pool.set(handle, { ...entry, freedAt: Date.now(), held: false })
    }
    this.seen.set(project, held)
    return held
  }

  /** Gives the handle; a terminal taking its own back (`keepAt`) keeps when it was given. */
  private give(project: string, handle: string, by: string | null, keepAt = false): void {
    const pool = this.pools.get(project) ?? new Map<string, MemoryHandle>()
    const now = Date.now()
    const at = keepAt ? (pool.get(handle)?.at ?? now) : now
    pool.set(handle, { freedAt: now, freedBy: by, seq: this.given++, at, held: true })
    this.pools.set(project, pool)
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
    this.streams.savedChanged(saved)
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
