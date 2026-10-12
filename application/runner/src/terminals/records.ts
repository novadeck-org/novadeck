import type { AgentName } from "@novadeck/protocol"

import type { Naming } from "./naming.js"
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
  /**
   * What names it: the person's title, an agent's, and its agent's summary of its work;
   * its title follows from these (see `titleOf`).
   */
  readonly naming: Naming
  /** The handle of the terminal whose agent opened it; null otherwise. */
  readonly openedBy: string | null
  /**
   * The handle of its lead: the terminal whose agent opened it with a brief to run an
   * agent there (`open_terminal` with `agent` and `message`); null otherwise, even for a
   * terminal an agent opened for a command or a plain shell.
   */
  readonly ledBy: string | null
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

/** A terminal's handle, what names it, and who opened it and who leads it. */
export type TerminalIdentity = Pick<SavedTerminal, "handle" | "naming" | "openedBy" | "ledBy">

/** Where the runner saves terminals: its metadata store. */
export type TerminalRecords = {
  terminal(terminalId: string): SavedTerminal | undefined
  /** Every terminal kept, of one session or all, in the order they were asked for (by number), without transcripts. */
  terminals(sessionId?: string): readonly ListedTerminal[]
  /** The next number of a session's terminals, for a handle and a default title, never given twice. */
  nextTerminalNumber(sessionId: string): number
  /**
   * Gives a kept terminal the person's title, or with null takes theirs away, so its title
   * is automatic again; false when none is kept by that id.
   */
  renameTerminal(terminalId: string, title: string | null): boolean
  /** A kept terminal's handle, what names it and who opened it, read alone. */
  terminalIdentity(terminalId: string): TerminalIdentity | undefined
  /** `transcript` is left as it is when omitted. */
  saveTerminal(terminal: TerminalToSave): void
  removeTerminal(terminalId: string): void
  clearTranscripts(): void
  /** Takes murmur's title from every kept terminal, as once murmur is turned off or removed; the ids it took it from. */
  clearMurmurTitles(): readonly string[]
  /** Forgets every session the agent reported, as once it is disconnected. */
  forgetAgent(agent: AgentName): void
}

/** What saving a terminal takes; `transcript` is left as it is when omitted. */
export type TerminalToSave = Omit<SavedTerminal, "transcript" | "savedAt"> & {
  transcript?: string | null
}
