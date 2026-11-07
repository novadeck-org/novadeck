import type { AgentName } from "@novadeck/protocol"

import type { AgentReport, KeptInterruption } from "../terminals/saved-terminals.js"
import type { Naming } from "../terminals/titles.js"

/**
 * A closed terminal as History keeps it: what restoring it needs, built by the caller from
 * the terminal's record in memory. Its `agents` come without `turn`, which only a live
 * session has.
 */
export type ClosedRecord = {
  /** The id the terminal had. */
  readonly id: string
  readonly projectId: string
  /** The session it was closed in; a row outlives it. */
  readonly sessionId: string
  readonly handle: string
  /** What names it, each layer as it was. */
  readonly naming: Naming
  /** The agent whose icon it shows; null for a plain terminal. */
  readonly agent: AgentName | null
  /** The program in its foreground when it closed, for a plain terminal's icon. */
  readonly lastProgram: string | null
  /** The command it was opened to run; null for a plain shell. */
  readonly command: string | null
  readonly cwd: string
  readonly agents: Partial<Record<AgentName, AgentReport>>
  readonly interruptions: readonly KeptInterruption[]
  /** A plain terminal's serialized screen and scrollback; null for an agent's or when off. */
  readonly transcript: string | null
  /** When it was closed, in epoch milliseconds. */
  readonly closedAt: number
  /** The handle of the agent that closed it; null when the person did. */
  readonly closedBy: string | null
}

/** A closed terminal as listed: all but its transcript. */
export type ListedClosed = Omit<ClosedRecord, "transcript">

/** Where the runner keeps closed terminals: its metadata store. */
export type ClosedRecords = {
  /** Keeps a closed row, replacing one of the same id. */
  insertClosed(record: ClosedRecord): void
  /** A project's closed rows, newest first, without transcripts. */
  closed(projectId: string): readonly ListedClosed[]
  /** One row with its transcript. */
  closedTerminal(id: string): ClosedRecord | undefined
  /** Deletes one row for good; whether there was one. */
  removeClosed(id: string): boolean
  /** Deletes the rows closed before `before` for good; their ids. */
  pruneClosed(before: number): readonly string[]
}
