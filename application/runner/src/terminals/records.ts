import type { AgentName } from "@novadeck/protocol"

import type { Work } from "./work.js"

/** An agent's latest reported session in a terminal; a larger `seq` is a later report. */
export type AgentReport = { readonly sessionId: string; readonly seq: number }

/**
 * What the runner keeps of a terminal: the terminal itself, which exists until it is
 * closed, and what restores it once its shell is gone.
 */
export type SavedTerminal = {
  readonly id: string
  readonly sessionId: string
  /** Its handle in its session, `t3`, which never changes. */
  readonly handle: string
  /** The title the person gave it, or its session's default. */
  readonly title: string
  /** The handle of the terminal whose agent gave it its title; null when the person did, or by default. */
  readonly titledBy: string | null
  /** The command it was opened to run; null for a plain shell. */
  readonly command: string | null
  /** The program in its foreground when its shell was last seen. */
  readonly lastProgram: string | null
  /** What its root agent session worked on. */
  readonly work: Work | null
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

/** A terminal as listed: all but its transcript. */
export type ListedTerminal = Omit<SavedTerminal, "transcript">

/** A terminal's handle, its title and who gave it. */
export type TerminalIdentity = Pick<SavedTerminal, "handle" | "title" | "titledBy">

/** Where the runner saves terminals: its metadata store. */
export type TerminalRecords = {
  terminal(terminalId: string): SavedTerminal | undefined
  /** Every terminal kept, of one session or all, oldest first, without transcripts. */
  terminals(sessionId?: string): readonly ListedTerminal[]
  /** The next number of a session's terminals, for a handle and a default title, never given twice. */
  nextTerminalNumber(sessionId: string): number
  /** Renames a kept terminal, as the person did; false when none is kept by that id. */
  renameTerminal(terminalId: string, title: string): boolean
  /** A kept terminal's handle, title and who gave it, read alone. */
  terminalIdentity(terminalId: string): TerminalIdentity | undefined
  /** `transcript` is left as it is when omitted. */
  saveTerminal(
    terminal: Omit<SavedTerminal, "transcript" | "savedAt"> & { transcript?: string | null },
  ): void
  removeTerminal(terminalId: string): void
  clearTranscripts(): void
  /** Forgets every session the agent reported, as once it is disconnected. */
  forgetAgent(agent: AgentName): void
}
