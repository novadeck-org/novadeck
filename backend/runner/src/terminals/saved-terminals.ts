import type { AgentName } from "@novadeck/protocol"

import type { Held } from "../messaging/messages.js"
import type { Naming } from "./titles.js"
import type { Work } from "./work.js"

/**
 * What an agent's session was doing when last saved, for a restart of Novadeck to tell a
 * resumed agent of (see `terminals/interrupted.ts`): its turn was running, or it waited on a
 * wake-up or background command it had set, which a restart stops too. Absent otherwise.
 */
export type AgentTurn = "running" | "waking"

/**
 * What Novadeck told a session once, which stays in its context until it compacts: the
 * rules notes of deliveries it was given in full (`Held`), and the notices of its bar and
 * Inbox, each as worded when it was told. Kept only where its harness keeps what a hook printed for later turns.
 */
export type Told = {
  readonly notes?: Held
  /** The bar's and Inbox's notices, by the digest of their wording when told (`barDigest`). */
  readonly bar?: string
}

/**
 * An agent's latest reported session in a terminal; a larger `seq` is a later report. `turn`,
 * `told` and `endedAt` are kept in the saved row's JSON, so rows saved without them read as
 * having none, and all stay with the session only while it is the same one.
 */
export type AgentReport = {
  readonly sessionId: string
  readonly seq: number
  /**
   * The session's own folder, as its harness named it when it bound (the terminal's, where
   * it didn't): where a resume must run, since a harness looks a conversation up by it.
   */
  readonly cwd?: string
  /** The conversation's file as its harness named it at bind, a hint for finding it again. */
  readonly transcript?: string
  readonly turn?: AgentTurn
  readonly told?: Told
  /**
   * When the session's last completed or failed turn ended, in epoch milliseconds: kept with
   * the session, as the Inbox's stored turns go once read, so a sleeper's tab keeps its age.
   */
  readonly endedAt?: number
  /**
   * The flags the agent was launched with that a resume carries over (`launch.kept`: its
   * permission mode, sandbox, model and effort), as its hooks reported them; rows saved
   * without them read as none, and a new session has the flags of the process that
   * started it.
   */
  readonly launch?: readonly string[]
}

/**
 * Where the person interrupted a turn of an agent session whose transcript doesn't record
 * it (Antigravity's): the session, the last step its transcript had at the key, and when.
 */
export type KeptInterruption = {
  readonly sessionId: string
  readonly step: number
  readonly at: number
}

/**
 * What the runner keeps of a terminal: the terminal itself, which exists until it is
 * closed, and what restores it once its shell is gone.
 */
export type SavedTerminal = {
  readonly id: string
  readonly sessionId: string
  /** Its handle in its session, a word such as `moth`, which never changes. */
  readonly handle: string
  /**
   * What names it: the person's title, an agent's, and its agent's summary of its work;
   * its title follows from these (see `titleOf`).
   */
  readonly naming: Naming
  /** The handle of the terminal whose agent opened it; null otherwise. */
  readonly openedBy: string | null
  /**
   * The handle of its lead: the terminal whose agent opened it to lead the agent there
   * (`open_agent`, by default with a brief), or one the person approved through `lead`;
   * null otherwise, even for a terminal an agent opened for a command or a plain shell.
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
  /** Where the person interrupted turns its agents' transcripts don't record, oldest first. */
  readonly interruptions: readonly KeptInterruption[]
  /** The serialized screen and scrollback; null when transcripts are off. */
  readonly transcript: string | null
  /** When it was last saved, in epoch milliseconds. */
  readonly savedAt: number
}

/**
 * Whether an agent has reported a session in the terminal, running now or since exited:
 * then something may name it by its handle.
 */
export const hasRun = (agents: SavedTerminal["agents"]): boolean => Object.keys(agents).length > 0

/**
 * What a restored terminal's record takes back as it was saved: when its shell last showed
 * its prompt, and where the person interrupted turns its transcripts don't record.
 */
export const keptState = (
  saved: SavedTerminal | undefined,
): { promptedAt: number | null; interruptions?: readonly KeptInterruption[] } => ({
  promptedAt: saved?.promptedAt ?? null,
  ...(saved && saved.interruptions.length > 0 && { interruptions: saved.interruptions }),
})

/** A terminal as listed: all but its transcript and its interruptions. */
export type ListedTerminal = Omit<SavedTerminal, "transcript" | "interruptions">

/** A terminal's handle, what names it, and who opened it and who leads it. */
export type TerminalIdentity = Pick<SavedTerminal, "handle" | "naming" | "openedBy" | "ledBy">

/** Where the runner saves terminals: its metadata store. */
export type TerminalRecords = {
  terminal(terminalId: string): SavedTerminal | undefined
  /** Whether a line was ever entered in the terminal; true for one kept before it was told. */
  terminalRan?(terminalId: string): boolean
  /** Every terminal kept, of one session or all, in the order they were created, without transcripts. */
  terminals(sessionId?: string): readonly ListedTerminal[]
  /**
   * Gives a session's next terminal its handle, from the words in `order` (the session's
   * own, see `handleOrder`, when omitted), never one the session gave before, even to a
   * terminal since closed (see `nextHandle`), and records it as given.
   */
  giveHandle(sessionId: string, order?: readonly string[]): string
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
  /**
   * Forgets every transcript that is not shaped as a sealed one: `prefix`, then at least
   * `minChars` characters of base64, and nothing else.
   */
  forgetUnsealed(sealed: { readonly prefix: string; readonly minChars: number }): void
  /** Takes murmur's title from every kept terminal, as once murmur is turned off or removed; the ids it took it from. */
  clearMurmurTitles(): readonly string[]
  /** Forgets every session the agent reported, as once it is disconnected. */
  forgetAgent(agent: AgentName): void
}

/**
 * What saving a terminal takes; `transcript` is left as it is when omitted, and without
 * `interruptions` it keeps none.
 */
export type TerminalToSave = Omit<SavedTerminal, "transcript" | "savedAt" | "interruptions"> & {
  transcript?: string | null
  interruptions?: SavedTerminal["interruptions"]
  /** Whether a line was ever entered in it; the records never lower it. */
  ran?: boolean
}
