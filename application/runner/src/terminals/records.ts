import type { AgentName } from "@novadeck/protocol"

/** An agent's latest reported session in a terminal; a larger `seq` is a later report. */
export type AgentReport = { readonly sessionId: string; readonly seq: number }

/** What the runner keeps of a terminal to restore it once its shell is gone. */
export type SavedTerminal = {
  readonly id: string
  readonly sessionId: string
  /** The shell's last reported directory, or where it started. */
  readonly cwd: string
  readonly agents: Partial<Record<AgentName, AgentReport>>
  /** When the shell last showed its prompt, in epoch milliseconds. */
  readonly promptedAt: number | null
  /** The serialized screen and scrollback; null when transcripts are off. */
  readonly transcript: string | null
  /** When it was last saved, in epoch milliseconds. */
  readonly savedAt: number
}

/** Where the runner saves terminals: its metadata store. */
export type TerminalRecords = {
  terminal(terminalId: string): SavedTerminal | undefined
  /** `transcript` is left as it is when omitted. */
  saveTerminal(
    terminal: Omit<SavedTerminal, "transcript" | "savedAt"> & { transcript?: string | null },
  ): void
  removeTerminal(terminalId: string): void
  clearTranscripts(): void
  /** Forgets every session the agent reported, as once it is disconnected. */
  forgetAgent(agent: AgentName): void
}
