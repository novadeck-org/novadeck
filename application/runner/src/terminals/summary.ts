import type { TerminalSummary } from "@novadeck/protocol"
import type { Terminal } from "@novadeck/terminal/host"

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
