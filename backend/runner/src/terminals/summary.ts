import type { AgentName, TerminalSummary } from "@novadeck/protocol"
import type { Terminal } from "@novadeck/terminal/host"

import { hasRun, type ListedTerminal } from "./saved-terminals.js"
import { summaryTitle } from "./titles.js"

/** A terminal's summary without what its host keeps: its size, its exit and its run. */
export type AgentSummary = Omit<TerminalSummary, "cols" | "rows" | "exit" | "run">

/** What a summary says of an agent where none is known: a new shell's, or an ended one's. */
export const noAgent = {
  agent: null,
  ready: null,
  startup: null,
  activity: null,
  telemetry: null,
  reported: null,
  sleeping: false,
  restingAgent: null,
} as const

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

/** What a saved terminal says of its sleeping agent, if one rests there (see `Sleepers`). */
export type Resting = {
  readonly agent: AgentName
  /** Whether its wake is wanted already: a `create` is coming, so it is not asleep. */
  readonly waking: boolean
  /** The standing report of the agent's session, so a done mark survives its sleep. */
  readonly reported: TerminalSummary["reported"]
}

/** A terminal kept only as saved, as clients see it: no shell, its last facts. */
export const savedSummaryOf = (terminal: ListedTerminal, resting?: Resting): TerminalSummary => ({
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
  ...noAgent,
  ...(resting && {
    sleeping: !resting.waking,
    restingAgent: resting.agent,
    reported: resting.reported,
  }),
})
