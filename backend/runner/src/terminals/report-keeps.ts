import type { AgentName } from "@novadeck/protocol"

import type { LoggedReport } from "../messaging/report-log.js"

/** A terminal as the report log's retention reads it: its id and the agent sessions it reported. */
type Held = {
  readonly id: string
  readonly agents: Partial<Record<AgentName, { readonly sessionId: string }>>
}

/**
 * What the retention of the report log reads of the runner: the running terminals with the
 * session bound in each, the saved ones (asleep or exited, and the running ones' saved
 * rows), the rows History keeps, and the ids of the terminals closed, though the runner has
 * yet to let go of them.
 */
export type KeepParts = {
  readonly running: ReadonlyMap<
    string,
    {
      readonly agents: Held["agents"]
      readonly bound: {
        readonly binding: { readonly agent: AgentName; readonly sessionId: string }
      } | null
    }
  >
  /** The terminals kept; undefined where that can't be told (a failed read, a stopping runner). */
  readonly saved: { known(): readonly Held[] | undefined }
  readonly history: { all(): readonly Held[] }
  readonly closing: ReadonlySet<string>
}

const keyOf = (agent: string, sessionId: string): string => `${agent}\u0000${sessionId}`

/** How many other sessions of an open terminal keep their rows, the latest by their newest row. */
export const keptOthers = 3

/**
 * Which of the report log's `rows` are still wanted: those of an agent session that an open
 * terminal (running or asleep) or a closed one History keeps holds, through the sessions it
 * reported or has bound, as a terminal restored from History, or a session resumed in
 * another, reads what the session reported before. Of the other sessions a terminal made
 * rows in (it was cleared or restarted over and over), only the latest `keptOthers` stay.
 * A terminal closing does not count as open: it is History's row that keeps its rows, if
 * there is one, and its rows go with the close if not. Judged from the runner as it is
 * now, once per sweep. Undefined where the runner can't tell (a read failed or it is
 * stopping), so that nothing is dropped on a guess.
 */
export const reportKeeps = (
  rows: readonly LoggedReport[],
  running: KeepParts["running"],
  saved: KeepParts["saved"],
  history: KeepParts["history"],
  closing: KeepParts["closing"],
): ((row: LoggedReport) => boolean) | undefined => {
  const kept = saved.known()
  if (kept === undefined) return undefined
  const terminals = new Set<string>()
  const sessions = new Set<string>()
  const hold = ({ id, agents }: Held) => {
    terminals.add(id)
    for (const [agent, report] of Object.entries(agents))
      if (report) sessions.add(keyOf(agent, report.sessionId))
  }
  for (const [id, record] of running) {
    if (closing.has(id)) continue
    hold({ id, agents: record.agents })
    const binding = record.bound?.binding
    if (binding) sessions.add(keyOf(binding.agent, binding.sessionId))
  }
  for (const each of kept) if (!closing.has(each.id)) hold(each)
  for (const each of history.all()) hold(each)
  // The sessions of a terminal that it holds no longer: its latest few, by newest row.
  const newest = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const key = keyOf(row.agent, row.sessionId)
    if (!terminals.has(row.terminalId) || sessions.has(key)) continue
    const own = newest.get(row.terminalId) ?? new Map<string, number>()
    own.set(key, Math.max(own.get(key) ?? -Infinity, row.at))
    newest.set(row.terminalId, own)
  }
  const others = new Set<string>()
  for (const [terminalId, own] of newest)
    for (const [key] of [...own].toSorted((a, b) => b[1] - a[1]).slice(0, keptOthers))
      others.add(`${terminalId}\u0000${key}`)
  return (row) => {
    const key = keyOf(row.agent, row.sessionId)
    return sessions.has(key) || others.has(`${row.terminalId}\u0000${key}`)
  }
}
