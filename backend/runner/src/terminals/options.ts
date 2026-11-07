import type { Install, Model } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"
import type { ProcessTrees, PtyOptions } from "@novadeck/terminal/pty"
import type { InterruptOptions, PromptOptions } from "@novadeck/tui-input"

import type { CompanionItems } from "../companions/items.js"
import type { DoorbellOptions } from "../messaging/doorbell.js"
import type { InboxRecords } from "../messaging/inbox.js"
import type { MessageRecords } from "../messaging/records.js"
import type { Describer } from "../murmur/describer.js"
import type { InstalledShell } from "../shell/install.js"
import type { AnswersOptions } from "./answers.js"
import type { MurmurTimes } from "./descriptions.js"
import type { DialogsOptions } from "./dialogs.js"
import type { HistoryRecords, HistoryTimes } from "./history.js"
import type { TranscriptRedactor } from "./redaction.js"
import type { TerminalRecords } from "./saved-terminals.js"
import type { TranscriptSealer } from "./sealing.js"

export type TerminalOptions = {
  shell?: string
  shellArgs?: readonly string[]
  /** Variables shells get on top of `baseEnv`. */
  env?: NodeJS.ProcessEnv
  /** The environment shells start from: the runner's own when omitted. */
  baseEnv?: NodeJS.ProcessEnv
  /**
   * Whether each new shell's PATH is read anew, as Windows keeps it, so a program
   * installed since the app started is on it (see `refreshPath`). On unless `baseEnv`
   * sets the environment exactly.
   */
  freshPath?: boolean
  /** Running and retained terminals together; unlimited when omitted. */
  maxTerminals?: number
  /** Exited, unattached records kept for viewing or restart; the oldest go first. */
  maxRetained?: number
  historyBytes?: number
  subscriberBytes?: number
  snapshotBytes?: number
  ackWindowBytes?: number
  /** How often running terminals' foreground processes are sampled, in milliseconds. */
  processPollMs?: number
  /**
   * The shell integration and hook, once written (see `installShellFiles`). Without
   * them, shells start as they are and no agent session is reported.
   */
  shellFiles?: Promise<InstalledShell | undefined>
  /** Where terminals are saved for restoring; unsaved when omitted. */
  records?: TerminalRecords
  /** Where closed terminals are kept for History; none is kept when omitted. */
  closed?: HistoryRecords
  /** Every project's id, for History's list of all closed terminals. */
  projects?: () => readonly string[]
  /** How long History waits, as in some tests. */
  historyTimes?: Partial<HistoryTimes>
  /** The order each session gives handle words in: its own shuffle when omitted (see `handleOrder`). */
  handleOrder?: (sessionId: string) => readonly string[]
  /** The connected harnesses whose shims new shells put first on PATH. */
  shims?: () => Promise<readonly AgentName[]>
  /**
   * Whether Novadeck's plugin is installed into the harness: a disconnected one resumes
   * nothing and its reports are ignored. Every harness counts as connected when omitted.
   */
  connected?: (agent: AgentName) => Promise<boolean>
  /** Whether terminals' transcripts are kept, until `keepTranscripts` changes it. */
  transcripts?: boolean
  /** How often changed terminals are saved, in milliseconds. */
  saveMs?: number
  /** How often a changed terminal's transcript is saved, in milliseconds. */
  transcriptMs?: number
  /** How long the last transcripts get as the runner shuts down, in milliseconds. */
  transcriptShutdownMs?: number
  /** Masks secrets in transcripts before they are saved; a worker thread by default. */
  redactor?: TranscriptRedactor
  /** Seals transcripts to save and opens them; none is saved or shown without it. */
  sealer?: TranscriptSealer
  /** How long a restored terminal waits for the sealer's key, in milliseconds. */
  transcriptKeyMs?: number
  /** The longest transcript kept per terminal, in characters. */
  transcriptChars?: number
  /**
   * What agents show beside terminals, and the plans each terminal's agent keeps there;
   * agents show nothing without it.
   */
  items?: CompanionItems
  /** The folder of the project a session belongs to, which names the files its agents show. */
  projectFolder?: (sessionId: string) => string | undefined
  /** How long an agent's request for a new terminal waits for the client's answer, in milliseconds. */
  openMs?: number
  /** Where agents' messages, their threads and the messaging pause are kept; in memory when omitted. */
  messages?: MessageRecords
  inbox?: InboxRecords
  /**
   * The project a session belongs to, whose terminals' agents message each other; each
   * session counts as its own when omitted, or when that cannot be told.
   */
  projectOf?: (sessionId: string) => string | undefined
  /**
   * Writes terminals' titles and summaries (see `Murmur`); nothing is described without it.
   * `murmurTimes` shortens its waits, as in some tests.
   */
  describer?: Describer
  murmurTimes?: Partial<MurmurTimes>
  /** How the doorbell rings idle agents; it never rings with `false`, as in some tests. */
  doorbell?: DoorbellOptions | false
  /** How prompts the chat gives agents are typed, with its waits, as in some tests. */
  prompts?: PromptOptions
  /** How interrupts wait, as in some tests. */
  interrupts?: InterruptOptions
  /** How answers the chat gives agents' dialogs are pressed, and how dialogs are read, with their waits, as in some tests. */
  answers?: AnswersOptions & DialogsOptions
  /**
   * Where a harness lives on this machine, which says how it may start with a task; a
   * harness counts as having none when omitted.
   */
  install?: (agent: AgentName) => Promise<Install | undefined>
  /**
   * The models a harness can start with on this machine, which an agent's request for a
   * model is checked against; none when omitted.
   */
  models?: (agent: AgentName) => Promise<readonly Model[]>
  /**
   * Whether Novadeck's hooks run for the harness in a folder, where it runs them only
   * once the person trusts them (`Harness.hooksTrusted`); asked of the harness itself when
   * omitted. Undefined, or a failure, is unknown.
   */
  hooksTrusted?: (agent: AgentName, cwd: string) => Promise<boolean | undefined>
  /**
   * The platform harnesses run their hooks on, which sets how long a hook may take to come
   * (see `hookShellSlackMs`); the runner's own when omitted.
   */
  platform?: NodeJS.Platform
  /**
   * The runner's own relay, which on Windows reads the registry's PATH and terminals'
   * process trees; the one `@novadeck/relay` built when omitted. Never the copy installed
   * for agents, which may be another build's, and waits on the shell files being written.
   */
  relay?: string
  /**
   * The pty: where its program is kept, and as a test plays it, node-pty's `spawn`, the
   * platform its ending follows (this system's when omitted, whatever `platform` says, as
   * real shells run here), and the process trees a Windows terminal's programs end by.
   */
  pty?: PtyOptions & { readonly trees?: ProcessTrees }
}
