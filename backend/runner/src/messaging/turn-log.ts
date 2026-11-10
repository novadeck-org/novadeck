/**
 * A finished turn of an agent session, as `team` reads it: when it ended, how, and the start
 * of its reply or its error, both redacted as its Inbox row is.
 */
export type LoggedTurn = {
  readonly projectId: string
  readonly agent: string
  readonly sessionId: string
  readonly at: number
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

  /** Keeps a turn, or replaces the one that ended at the same moment: oldest first. */
  record(terminalId: string, turn: LoggedTurn): void {
    const kept = (this.turns.get(terminalId) ?? []).filter((each) => each.at !== turn.at)
    this.turns.set(terminalId, [...kept, turn].toSorted((a, b) => a.at - b.at).slice(-keptTurns))
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
