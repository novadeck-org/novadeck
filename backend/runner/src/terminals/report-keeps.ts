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
  readonly saved: { terminals(): readonly Held[] }
  readonly history: { all(): readonly Held[] }
  readonly closing: ReadonlySet<string>
}

const keyOf = (agent: string, sessionId: string): string => `${agent}\u0000${sessionId}`

/**
 * Which report log rows are still wanted: those made in a terminal that is open (running or
 * asleep) or whose closed row History keeps, and those of an agent session one of them
 * holds, as a terminal restored from History, or a session resumed in another, reads what
 * the session reported before. A terminal closing does not count as open: it is History's
 * row that keeps its rows, if there is one, and its rows go with the close if not. Judged
 * from the runner as it is now, once per sweep.
 */
export const reportKeeps = (
  running: KeepParts["running"],
  saved: KeepParts["saved"],
  history: KeepParts["history"],
  closing: KeepParts["closing"],
): ((row: LoggedReport) => boolean) => {
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
  for (const each of saved.terminals()) if (!closing.has(each.id)) hold(each)
  for (const each of history.all()) hold(each)
  return (row) => terminals.has(row.terminalId) || sessions.has(keyOf(row.agent, row.sessionId))
}
