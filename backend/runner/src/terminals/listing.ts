import type { TerminalSummary } from "@novadeck/protocol"

import type { Record } from "./record.js"
import type { ListedTerminal } from "./saved-terminals.js"
import { summaryOf } from "./summary.js"

/** What a listing reads of the runner's terminals. */
export type ListingHost = {
  /** Every terminal the runner holds. */
  readonly records: () => Iterable<Record>
  /** The terminals kept, of one session or all, in the order they were asked for. */
  readonly kept: (sessionId?: string) => readonly ListedTerminal[]
  /** Whether a closed terminal's record still drains to its viewers. */
  readonly draining: (terminalId: string) => boolean
  /** A terminal kept only as saved, as clients see it (asleep or not). */
  readonly saved: (terminal: ListedTerminal) => TerminalSummary
  /** Where a handle comes in the order its project gave them (creation order), for those the records don't keep. */
  readonly order: (sessionId: string, handle: string) => number
}

/**
 * Every terminal of a session, or of all: those running, and those kept only as saved,
 * which have no shell in this runner's lifetime until a client restores them.
 */
export const listTerminals = (host: ListingHost, sessionId?: string): TerminalSummary[] => {
  const live = new Map(
    [...host.records()]
      .filter(
        (record) =>
          !record.closed && (sessionId === undefined || record.summary.sessionId === sessionId),
      )
      .map((record) => [record.summary.id, summaryOf(record)] as const),
  )
  const kept = host.kept(sessionId)
  // In the order they were asked for, as the records keep them; a running one they don't
  // keep, as without records, follows.
  const listed = kept.flatMap((terminal) => {
    const running = live.get(terminal.id)
    if (running) return [running]
    return host.draining(terminal.id) ? [] : [host.saved(terminal)]
  })
  const recorded = new Set(kept.map(({ id }) => id))
  const given = (summary: TerminalSummary) => host.order(summary.sessionId, summary.handle)
  const unrecorded = [...live.values()]
    .filter(({ id }) => !recorded.has(id))
    .toSorted((a, b) => given(a) - given(b))
  return [...listed, ...unrecorded]
}
