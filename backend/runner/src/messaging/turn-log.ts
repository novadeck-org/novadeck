/**
 * A finished turn of an agent session, as `team` reads it: when it ended, how, and the start
 * of its reply or its error, both redacted as its Inbox row is.
 */
export type LoggedTurn = {
  readonly projectId: string
  readonly agent: string
  readonly sessionId: string
  readonly at: number
  /** When it started; null where that isn't known, as for a turn read back after a restart. */
  readonly from: number | null
  readonly outcome: "completed" | "failed"
  readonly reply: string | null
  readonly error: string | null
}

/** How many of each terminal's latest finished turns are kept. */
export const keptTurns = 10

/**
 * Each terminal's latest finished turns, in memory, as Inbox stores them: a lead's `team`
 * lists a worker's turns that ended without a report, which the person's reading of their
 * Inbox rows must not take away, so this record is apart from the rows. It holds the turns
 * of whichever session ended them; readers pick their session's.
 */
export class TurnLog {
  private readonly turns = new Map<string, LoggedTurn[]>()

  /**
   * Keeps a turn, or replaces the one that ended at the same moment, keeping its start
   * where the new one doesn't know it: oldest first.
   */
  record(terminalId: string, turn: LoggedTurn): void {
    const old = this.turns.get(terminalId) ?? []
    const from = turn.from ?? old.find((each) => each.at === turn.at)?.from ?? null
    const kept = old.filter((each) => each.at !== turn.at)
    this.turns.set(
      terminalId,
      [...kept, { ...turn, from }].toSorted((a, b) => a.at - b.at).slice(-keptTurns),
    )
  }

  /**
   * Changes how the kept turn that ended at `at` ended, if one is kept: its Inbox row may
   * be gone, read by the person, while this record still lists it.
   */
  amend(
    terminalId: string,
    at: number,
    fields: Pick<LoggedTurn, "outcome" | "reply" | "error">,
  ): void {
    const turn = this.turns.get(terminalId)?.find((each) => each.at === at)
    if (turn) this.record(terminalId, { ...turn, ...fields })
  }

  /** Forgets the turn that ended at `at`: it turned out otherwise (an interruption, a limit). */
  drop(terminalId: string, at: number): void {
    const kept = this.turns.get(terminalId)?.filter((each) => each.at !== at)
    if (kept?.length) this.turns.set(terminalId, kept)
    else this.turns.delete(terminalId)
  }

  /** The terminal's kept turns of one agent session, oldest first. */
  of(terminalId: string, session: { readonly agent: string; readonly sessionId: string }) {
    return (this.turns.get(terminalId) ?? []).filter(
      (turn) => turn.agent === session.agent && turn.sessionId === session.sessionId,
    )
  }

  /** Forgets the turns of every terminal `exists` no longer knows, and of a removed project. */
  retain(exists: (terminalId: string) => boolean, removedProject?: string): void {
    for (const [terminalId, turns] of this.turns)
      if (!exists(terminalId) || turns.some((turn) => turn.projectId === removedProject))
        this.turns.delete(terminalId)
  }
}
