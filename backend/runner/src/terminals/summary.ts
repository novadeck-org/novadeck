import type { TerminalSummary } from "@novadeck/protocol"
import type { Terminal } from "@novadeck/terminal/host"

import { summaryTitle } from "./naming.js"
import { hasRun, type ListedTerminal } from "./records.js"

/** A terminal's summary without what its host keeps: its size, its exit and its run. */
export type AgentSummary = Omit<TerminalSummary, "cols" | "rows" | "exit" | "run">

/** A terminal's whole summary: its record's half and its host's. */
export const summaryOf = (record: {
  readonly summary: AgentSummary
  readonly terminal: Pick<Terminal, "size" | "exit" | "run">
}): TerminalSummary => ({
  ...record.summary,
  ...record.terminal.size,
  exit: record.terminal.exit,
  run: record.terminal.run,
})

/** A terminal kept only as saved, as clients see it: no shell, its last facts. */
export const savedSummaryOf = (terminal: ListedTerminal): TerminalSummary => ({
  id: terminal.id,
  sessionId: terminal.sessionId,
  ...summaryTitle(terminal.naming, terminal),
  handle: terminal.handle,
  ledBy: terminal.ledBy,
  openedBy: terminal.openedBy,
  agentRan: hasRun(terminal.agents),
  started: false,
  command: terminal.command,
  lastProgram: terminal.lastProgram,
  cwd: terminal.cwd,
  cols: 80,
  rows: 24,
  run: 0,
  exit: null,
  process: null,
  agent: null,
  ready: null,
  activity: null,
  telemetry: null,
  reported: null,
})
