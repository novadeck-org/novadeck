import type { Install } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"

import type { HistoryHost } from "./history.js"
import type { Names } from "./names.js"
import type { Record } from "./record.js"
import { showNote } from "./restored.js"
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
  readonly closingSessions: ReadonlyMap<string, "project" | "session">
  readonly stopping: () => boolean
  readonly projectOf: (sessionId: string) => string
  readonly install: (agent: AgentName) => Promise<Install | undefined>
  readonly connected: (agent: AgentName) => Promise<boolean>
  readonly names: Pick<Names<Record>, "claim" | "next">
  readonly announce: (record: Record) => void
  /** The worktrees service, told when terminals are pruned or restored. */
  readonly worktrees?:
    | {
        ownersPruned(ids: readonly string[]): unknown
        ownerRestored(from: string, to: string): unknown
      }
    | undefined
  /** The terminal resting on the session, asleep or waking, with no agent bound yet. */
  readonly resting: (
    agent: AgentName,
    sessionId: string,
  ) => { readonly handle: string; readonly terminalId: string } | undefined
}

/** The terminal that has `agent`'s session bound or claimed to resume it. */
const holder = (
  parts: HistoryParts,
  agent: AgentName,
  sessionId: string,
): { readonly handle: string; readonly terminalId: string } | undefined => {
  for (const record of parts.records.values())
    if (
      !record.closed &&
      record.bound?.binding.agent === agent &&
      record.bound.binding.sessionId === sessionId
    )
      return { handle: record.summary.handle, terminalId: record.summary.id }
  // A sleeper holds its session though it has no record: a closed row is not one, and
  // restoring it would run a second copy of the conversation.
  const resting = parts.resting(agent, sessionId)
  if (resting) return resting
  const claimant = parts.claims.claimant(`${agent}:${sessionId}`)
  // A closed terminal keeps its claim until its shell ends, but it no longer holds the session.
  const claiming = claimant === undefined ? undefined : parts.records.get(claimant)
  return !claiming || claiming.closed
    ? undefined
    : { handle: claiming.summary.handle, terminalId: claiming.summary.id }
}

/** What History asks of the runner, answered from the manager's parts. */
export const historyHost = (parts: HistoryParts): HistoryHost => ({
  records: parts.closed,
  projects: () => parts.projects?.() ?? [],
  projectOf: parts.projectOf,
  // Only a project's own removal forgets its terminals; a session's keeps them.
  going: (sessionId) => parts.closingSessions.get(sessionId) === "project",
  stopping: parts.stopping,
  install: parts.install,
  connected: parts.connected,
  holder: (agent, sessionId) => holder(parts, agent, sessionId),
  claimHandle: (sessionId, handle, terminalId) => parts.names.claim(sessionId, handle, terminalId),
  drawHandle: (sessionId) => parts.names.next(sessionId),
  releaseClaim: (terminalId) => parts.claims.release(terminalId),
  archive: (record, write, settled) => parts.saves.archive(record, write, settled),
  saved: (record, done) => parts.saves.afterSaved(record, done),
  transcriptOf: (agent, sessionId) =>
    [...parts.records.values(), ...parts.saves.terminals()].find(
      (record) => record.agents[agent]?.sessionId === sessionId,
    )?.agents[agent]?.transcript,
  restoredBeside: (row) => {
    const found = [...parts.records.values()].find(
      (record) => !record.closed && record.restoredFrom === row,
    )
    return found && { handle: found.summary.handle, terminalId: found.summary.id }
  },
  restoredAs: (terminalId, row) => {
    const record = parts.records.get(terminalId)
    return record && !record.closed && record.restoredFrom === row ? summaryOf(record) : undefined
  },
  ran: (terminalId) => parts.kept?.terminalRan?.(terminalId) ?? true,
  announce: parts.announce,
  pruned: (ids) => void parts.worktrees?.ownersPruned(ids),
  restored: (from, to) => void parts.worktrees?.ownerRestored(from, to),
  // Above the prompt the shell just drew, drawn and sent to every window that shows it.
  say: (record, text) => void showNote(record.terminal, text, record.summary.id),
})
