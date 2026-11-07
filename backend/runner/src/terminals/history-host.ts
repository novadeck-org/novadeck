import type { Install } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"

import type { HistoryHost } from "./history.js"
import type { Record } from "./record.js"
import { showRestored } from "./restored.js"
import type { Claims } from "./resumes.js"
import type { TerminalRecords } from "./saved-terminals.js"
import type { Saves } from "./saving.js"
import { summaryOf } from "./summary.js"

/** What the manager lends History to read and ask of it. */
export type HistoryParts = {
  readonly records: ReadonlyMap<string, Record>
  readonly saves: Saves
  readonly claims: Claims
  readonly kept: TerminalRecords | undefined
  readonly closed: HistoryHost["records"]
  readonly projects: (() => readonly string[]) | undefined
  readonly closingSessions: ReadonlySet<string>
  readonly stopping: () => boolean
  readonly projectOf: (sessionId: string) => string
  readonly install: (agent: AgentName) => Promise<Install | undefined>
  readonly connected: (agent: AgentName) => Promise<boolean>
  readonly drawHandle: (sessionId: string) => string
  readonly announce: (record: Record) => void
}

/** The handle of the terminal that has `agent`'s session bound or claimed to resume it. */
const holder = (parts: HistoryParts, agent: AgentName, sessionId: string): string | undefined => {
  for (const record of parts.records.values())
    if (
      !record.closed &&
      record.bound?.binding.agent === agent &&
      record.bound.binding.sessionId === sessionId
    )
      return record.summary.handle
  const claimant = parts.claims.claimant(`${agent}:${sessionId}`)
  return claimant === undefined ? undefined : parts.records.get(claimant)?.summary.handle
}

/** What History asks of the runner, answered from the manager's parts. */
export const historyHost = (parts: HistoryParts): HistoryHost => ({
  records: parts.closed,
  projects: () => parts.projects?.() ?? [],
  projectOf: parts.projectOf,
  going: (sessionId) => parts.closingSessions.has(sessionId),
  stopping: parts.stopping,
  install: parts.install,
  connected: parts.connected,
  holder: (agent, sessionId) => holder(parts, agent, sessionId),
  terminalsIn: (sessionId) => [
    ...[...parts.records.values()]
      .filter((record) => !record.closed && record.summary.sessionId === sessionId)
      .map(({ summary }) => ({ handle: summary.handle, ledBy: summary.ledBy })),
    ...parts.saves.terminals(sessionId),
  ],
  drawHandle: parts.drawHandle,
  releaseClaim: (terminalId) => parts.claims.release(terminalId),
  archive: (record, write) => parts.saves.archive(record, write),
  transcriptOf: (agent, sessionId) =>
    [...parts.records.values()].find((record) => record.agents[agent]?.sessionId === sessionId)
      ?.agents[agent]?.transcript,
  restoredAs: (terminalId, row) => {
    const record = parts.records.get(terminalId)
    return record && !record.closed && record.restoredFrom === row ? summaryOf(record) : undefined
  },
  ran: (terminalId) => parts.kept?.terminalRan?.(terminalId) ?? true,
  announce: parts.announce,
  // Over the prompt line the shell just drew, so the note stands on a line of its own.
  say: (record, text) =>
    void showRestored(record.terminal, "", null, record.summary.id, `\r\x1b[2K${text}`),
})
