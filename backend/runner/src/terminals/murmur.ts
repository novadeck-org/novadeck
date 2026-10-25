import { createHash } from "node:crypto"
import { basename } from "node:path"

import { tailLines } from "@novadeck/harness-core/follow"
import { terminalTitle, type AgentName, type ForegroundProcess } from "@novadeck/protocol"

import type { Activity } from "../harnesses/activity.js"
import type { Items } from "../harnesses/replies.js"
import { logs } from "../log.js"
import type {
  Describer,
  Description,
  Digest,
  Note,
  NoteDigest,
  ReplyDigest,
  ShellDigest,
} from "../murmur/describer.js"
import { sharesContentWord } from "../murmur/description.js"
import type { PeerTerminal } from "./peers.js"
import { shorten } from "./work.js"

const log = logs.for("murmur")

/*
 * When a terminal is described by murmur, and from what (see docs/agent-messaging.md,
 * "Naming"). The terminals own the triggers, the digests and the coalescing; the service
 * behind the `Describer` owns the model, its prompt, redaction and validation.
 */

/** The waits and counts that decide when murmur describes; tests shorten them. */
export type MurmurTimes = {
  /**
   * How long an agent terminal's summary waits before it is named, in milliseconds, so a
   * burst of summaries makes one title.
   */
  readonly settleMs: number
  /**
   * How long a plain shell's program must have run before it describes while it runs: a
   * command that ends sooner (`ls`, `git status`) is described at the prompt after it
   * instead, never while it runs.
   */
  readonly shellRunMs: number
  /**
   * How long a plain shell waits for quiet after its prompt shows, so that commands typed
   * in quick succession make one description.
   */
  readonly shellSettleMs: number
  /**
   * How long a shell opened to run an agent is not described as a shell, while the agent
   * may yet bind, in milliseconds.
   */
  readonly expectMs: number
  /**
   * How long a title or gist that could not be asked for (murmur backed off or busy: it did
   * not run) waits before it is asked again, in milliseconds.
   */
  readonly retryMs: number
  /** How long a gist waits before it is asked for, in milliseconds. */
  readonly noteMs: number
}

export const defaultTimes: MurmurTimes = {
  settleMs: 3_000,
  shellRunMs: 5_000,
  shellSettleMs: 3_000,
  expectMs: 10_000,
  retryMs: 60_000,
  noteMs: 1_000,
}

// These are generous safety caps only. The service redacts every string before it cuts
// any, so a cap here must never cut a secret in half ahead of the redaction; it applies
// the caps the model is shown (a reply's ends, a screen of the last few rows) afterwards.

/** How many logical lines of a plain shell's screen, how long each; the lowest lines win. */
export const screenRows = 100
export const screenColumns = 8000
/** The longest command line passed on. */
export const commandChars = 2000
/** How much of a reply is shown: its first and last characters. */
export const replyHeadChars = 4000
export const replyTailChars = 4000

// Characters no reply or screen row shows to a model: C0 and C1 control characters, and DEL.
// eslint-disable-next-line no-control-regex -- These are the characters it removes.
const control = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
// eslint-disable-next-line no-control-regex -- Escape sequences, whole.
const escapes = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/**
 * What the agent said last since the person's latest prompt and its latest tool step, as
 * its transcript records it, through its harness's items, cleaned; null when it said
 * nothing since or the transcript can't be read. Words before a tool call are its working
 * notes, not its reply. Only the end of the transcript is read.
 */
export const lastReply = async (path: string, items: Items): Promise<string | null> => {
  const lines = await tailLines(path)
  let reply: string | undefined
  for (const line of lines ?? [])
    for (const { role, kind, text } of items(line)) {
      if (role === "user" || role === "tool" || kind === "tool-call") reply = undefined
      else if (role === "assistant" && kind === "text" && text.trim()) reply = text
    }
  if (reply === undefined) return null
  return reply.replace(escapes, "").replace(control, " ").trim() || null
}

/** What murmur is shown of a reply: all of it when short, else its first and last characters. */
export const replyDigest = (reply: string, failed: boolean): ReplyDigest => {
  const characters = [...reply]
  return {
    kind: "reply",
    reply:
      characters.length > replyHeadChars + replyTailChars
        ? `${characters.slice(0, replyHeadChars).join("")}\n…\n${characters.slice(-replyTailChars).join("")}`
        : reply,
    failed,
  }
}

/**
 * The command a plain shell's foreground program runs with, or its name where the
 * platform tells no more; null at the shell's own prompt (`atPrompt`: the shell holds the
 * foreground, so a script its interpreter runs is a program, not the prompt), and where
 * none is told.
 */
export const commandOf = (program: ForegroundProcess | null, atPrompt: boolean): string | null => {
  if (!program || atPrompt) return null
  const line = program.argv && program.argv.length > 0 ? program.argv.join(" ") : program.name
  return shorten(line, commandChars)
}

/**
 * The visible rows of a plain shell's screen as murmur is shown them: rows the terminal
 * wrapped (`wrapped[i]` continues the row before) joined into the logical line they are,
 * so a value split across rows is whole for the redaction; control characters out, each
 * line trimmed and, only far past any real line, cut at the safety cap (it must not cut a
 * value ahead of the redaction, which the service does before its caps), the blank ones
 * above and below dropped, and at most the last `screenRows` kept.
 *
 * `continues[i]` says the line ended on a row drawn full across the screen (its last cell
 * held something: `rowContinues` for the screen's rows), so a value may go on in the line
 * below, as programs that position the cursor (tmux panes, vim, less) draw one. Rows are
 * never glued on that account: boxes and progress bars keep their lines.
 *
 * `mark` is a row of the screen (an index in `rows`) to follow: `at` is the index in the
 * returned `screen` of the line that row belongs to, and absent where that line was
 * dropped (blank above the first text or below the last, or above the last `screenRows`).
 */
export const screenLines = (
  rows: readonly string[],
  wrapped: readonly boolean[] = [],
  rowContinues: readonly boolean[] = [],
  mark?: number,
): {
  readonly screen: readonly string[]
  readonly continues: readonly boolean[]
  readonly at?: number
} => {
  const lines: string[] = []
  const ends: boolean[] = []
  let marked: number | undefined
  rows.forEach((row, index) => {
    if (wrapped[index] && lines.length > 0) lines[lines.length - 1] += row
    else lines.push(row)
    ends[lines.length - 1] = rowContinues[index] ?? false
    if (index === mark) marked = lines.length - 1
  })
  const kept = lines.map((line) =>
    shorten(line.replace(escapes, "").replace(control, " "), screenColumns),
  )
  while (kept.at(-1) === "") {
    kept.pop()
    ends.pop()
  }
  const start = kept.findIndex((row) => row !== "")
  if (start < 0) return { screen: [], continues: [] }
  const from = Math.max(start, kept.length - screenRows)
  const at = marked === undefined ? undefined : marked - from
  return {
    screen: kept.slice(from),
    continues: ends.slice(from, kept.length),
    ...(at !== undefined && at >= 0 && at < kept.length - from && { at }),
  }
}

/** The lines of `screenLines`, without which of them go on below. */
export const screenOf = (
  rows: readonly string[],
  wrapped: readonly boolean[] = [],
): readonly string[] => screenLines(rows, wrapped).screen

/**
 * What murmur is shown of a plain shell's terminal; null when there is nothing to say of
 * it: no program runs and the screen shows no more than a prompt.
 */
export const shellDigest = (input: {
  readonly projectFolder: string | undefined
  readonly command: string | null
  readonly rows: readonly string[]
  /** Which rows continue the one before, as the terminal wrapped a long line. */
  readonly wrapped?: readonly boolean[]
  /** Which of the screen's rows are drawn full across it (see `screenLines`). */
  readonly rowContinues?: readonly boolean[]
  /**
   * The row of the screen (an index in `rows`) the last command was typed on, as the
   * shell integration's prompt reports placed it; none where that is not known.
   */
  readonly commandRow?: number
  /**
   * A full-screen program (vim, less, htop, tmux) has the screen: what it draws is not
   * shown, so the digest has the program's command and project alone, and none at
   * all when the command is not known (the title stays as it is).
   */
  readonly alternate?: boolean
}): ShellDigest | null => {
  const { screen, continues, at } = input.alternate
    ? { screen: [], continues: [], at: undefined }
    : screenLines(input.rows, input.wrapped, input.rowContinues, input.commandRow)
  if (input.command === null && screen.length < 2) return null
  const { projectFolder } = input
  return {
    kind: "shell",
    project: projectFolder === undefined ? null : basename(projectFolder) || null,
    command: input.command,
    screen,
    ...(input.rowContinues && { continues }),
    ...(at !== undefined && { commandAt: at }),
  }
}

type Job = {
  readonly id: string
  /** The terminal it asks for, which `forget` cancels the jobs of. */
  readonly terminal: string
  timer: NodeJS.Timeout | undefined
  controller: AbortController | undefined
  /** The newest job's number. */
  latest: number
  /** Whether a job is building or waiting on the describer. */
  running: boolean
}

/**
 * Describes each terminal at most one job at a time: a request waits out its quiet
 * (a newer request for the same terminal restarts the wait), builds its digest then, and
 * aborts the terminal's older job before the describer is asked, so the newest digest
 * wins. A description lands only while its job is the newest.
 */
export class Descriptions<D = Digest, O = Description> {
  private readonly jobs = new Map<string, Job>()

  constructor(
    private readonly describer: {
      describe(
        digest: D,
        options: { readonly signal?: AbortSignal; readonly terminal: string },
      ): Promise<O | null | undefined>
    },
  ) {}

  /**
   * Asks for the description of `id`, a terminal or a key of one's (`terminal`), once
   * `delayMs` pass without another request.
   * `build` makes the digest (undefined for none, as when the terminal is gone) and
   * `done` takes the outcome: the description murmur wrote; null when it ran and refused a
   * title; undefined when it did not run (off, backed off, busy, dropped), or no digest could
   * be built. An aborted or superseded job reports nothing.
   */
  request(
    id: string,
    delayMs: number,
    build: () => Promise<D | undefined>,
    done: (outcome: O | null | undefined, digest: D | undefined) => void,
    terminal = id,
  ): void {
    const job = this.jobs.get(id) ?? {
      id,
      terminal,
      timer: undefined,
      controller: undefined,
      latest: 0,
      running: false,
    }
    this.jobs.set(id, job)
    clearTimeout(job.timer)
    job.timer = setTimeout(() => {
      job.timer = undefined
      void this.run(job, build, done)
    }, delayMs)
    job.timer.unref()
  }

  /** Drops a request still waiting for its quiet; a job already running goes on. */
  withdraw(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    clearTimeout(job.timer)
    job.timer = undefined
    if (!job.running) this.jobs.delete(id)
  }

  /** Forgets the terminal: its request is dropped and its running job aborted. */
  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    clearTimeout(job.timer)
    job.latest += 1
    job.controller?.abort()
    this.jobs.delete(id)
  }

  /** Cancels every job asked for the terminal. */
  forget(terminal: string): void {
    for (const job of this.jobs.values()) if (job.terminal === terminal) this.cancel(job.id)
  }

  stop(): void {
    for (const id of this.jobs.keys()) this.cancel(id)
  }

  private async run(
    job: Job,
    build: () => Promise<D | undefined>,
    done: (outcome: O | null | undefined, digest: D | undefined) => void,
  ): Promise<void> {
    job.latest += 1
    const mine = job.latest
    job.controller?.abort()
    const controller = new AbortController()
    job.controller = controller
    job.running = true
    try {
      const digest = await build()
      if (job.latest !== mine) return
      if (!digest) {
        done(undefined, undefined)
        return
      }
      const outcome = await this.describer.describe(digest, {
        signal: controller.signal,
        terminal: job.terminal,
      })
      if (job.latest === mine && !controller.signal.aborted) done(outcome, digest)
    } catch (error) {
      log.error("murmur.describe-failed", "Novadeck could not describe a terminal", { err: error })
    } finally {
      if (job.latest === mine) {
        job.running = false
        job.controller = undefined
        // Dropped once nothing waits.
        if (job.timer === undefined && this.jobs.get(job.id) === job) this.jobs.delete(job.id)
      }
    }
  }
}

/** What murmur needs of a running terminal, beyond what peers read of it. */
export type MurmurSubject = PeerTerminal & {
  /** The agent bound there, if one is; a terminal with none is a plain shell. */
  readonly agent: AgentName | null
  /** The bound session's transcript, where its hooks named one. */
  readonly transcript: string | null
  /** The program in the foreground. */
  readonly program: ForegroundProcess | null
  /**
   * Whether the shell itself holds the foreground, as at its prompt: told by the
   * foreground process group where the platform tells it (a script run by the shell's
   * own interpreter is not the prompt), else by the program's name.
   */
  readonly atPrompt: boolean
  /** The agent its terminal was opened to run, until one binds or the startup is over. */
  readonly expecting: AgentName | null
}

/** What the manager gives murmur's triggers to read and write. */
export type MurmurHost = {
  /** A running terminal, read afresh; undefined once it is gone. */
  subject(terminalId: string): MurmurSubject | undefined
  subjects(): readonly MurmurSubject[]
  /** The visible rows of the terminal's screen, and which of them the terminal wrapped. */
  screen(terminalId: string): Promise<
    | {
        readonly rows: readonly string[]
        readonly wrapped?: readonly boolean[]
        readonly continues?: readonly boolean[]
        /** Whether a full-screen program has the screen (the alternate buffer). */
        readonly alternate?: boolean
        /**
         * The row (an index in `rows`) the last command was typed on, from the shell
         * integration's prompt reports; absent where that is not known.
         */
        readonly commandRow?: number
      }
    | undefined
  >
  /** The harness's reader of its transcript's lines. */
  items(agent: AgentName): Items | undefined
  projectFolder(sessionId: string): string | undefined
  /** Gives the terminal murmur's title; nothing when it is gone. */
  described(terminalId: string, description: { readonly title: string }): void
  /** Gives the terminal's turn end at `at` its gist; nothing when that is no longer its last. */
  gisted(terminalId: string, at: number, gist: string): void
  /** Murmur was turned off or removed: every terminal loses its murmur title, saved ones too, and its gists. */
  cleared(): void
}

// What murmur keeps of a terminal between triggers; lost with the runner.
type Watch = {
  /**
   * The agent's summary its terminal was last named from (as `words` compares it), whether
   * the title was kept or refused; null when none was since the runner started or the
   * terminal last had a shell's title. The same summary again names nothing.
   */
  named: string | null
  /**
   * A summary's title was asked for and has not run yet: one that is stopped (murmur became
   * unusable) or did not run is asked for again.
   */
  owed: boolean
  /**
   * Whether murmur's title is one it wrote for the terminal as a plain shell since the runner
   * started: no name of an agent's work, so a summary's title always replaces it. One kept
   * across a restart is not known as one.
   */
  shellTitled: boolean
  /** The timer that asks again for a summary's title that did not run. */
  retryTimer: NodeJS.Timeout | undefined
  /** The program in a plain shell's foreground, as a key, and since when; null at the prompt. */
  program: { readonly key: string | null; readonly since: number }
  /** An agent was bound during the run in the foreground, whose end owes the shell no description. */
  agentRan: boolean
  /** A shell's description is owed (it returned to its prompt, or has none yet) and not built. */
  shellOwed: boolean
  /** A hash of what the last description of the shell was made from (see `screenKey`); null before any. */
  screenKey: string | null
  /** When murmur first looked at the terminal, from which an expected agent is waited for. */
  since: number
  /** The turn end (`lastTurn.at`) whose gist was asked for, so it is asked for once. */
  gist: number | null
  /** The gist asked for did not run: it is asked for again after `retryMs`. */
  gistOwed: boolean
  /** The timer that asks again for a gist that did not run. */
  noteRetry: NodeJS.Timeout | undefined
}

const gistKey = (terminalId: string): string => `${terminalId}\0gist`

/**
 * Whether a shell's screen shows only prompts: every row is the bottom row, or the line
 * the last command was typed on is, so nothing was entered after that prompt.
 */
const bare = (digest: ShellDigest): boolean => {
  const bottom = digest.screen.at(-1)
  if (bottom === undefined) return false
  if (digest.screen.every((row) => row === bottom)) return true
  return digest.commandAt !== undefined && digest.screen[digest.commandAt] === bottom
}

/**
 * What a shell's description is made from, as a short hash: its directory, its command and
 * its screen's rows. A prompt that shows the same again (a command that printed nothing,
 * a cleared screen) has nothing new to name.
 */
const screenKey = (
  cwd: string,
  command: string | null,
  rows: readonly string[],
  alternate: boolean,
): string =>
  createHash("sha256")
    .update(JSON.stringify([cwd, command, alternate ? null : rows]))
    .digest("hex")

// A summary as compared: lower case, spaces collapsed; null is none.
const words = (text: string | null): string =>
  (text ?? "").toLowerCase().replace(/\s+/g, " ").trim()

const programKey = (program: ForegroundProcess | null): string | null =>
  program === null ? null : JSON.stringify([program.name, program.argv])

/**
 * Decides when each terminal is described and what from, and hands the result to the
 * manager. Without a describer, nothing happens. A terminal the person titled is never
 * asked about; once they clear it, a summary written meanwhile names it at once.
 *
 * An agent's terminal is named from its agent's own summary alone (from `summarize`), each
 * time the agent writes one that says something new, `settleMs` after it so a burst makes
 * one title. The person's prompts and the agent's replies are never read for it: they name
 * steps (a critic pass, a merge), and the summary names the work. A new title replaces the
 * name only when it shares no content word with it, so a reworded summary of the same work
 * keeps it. With no summary, the terminal keeps the title it has, if any.
 *
 * A plain shell's: at every return to its prompt, after `shellSettleMs` of quiet so that
 * rapid commands make one description, unless its screen, directory and command are as
 * at the last description; and while a program in its foreground has run `shellRunMs`.
 * The foreground is sampled only where the platform tells it, so on Windows only the
 * prompt triggers. When murmur becomes usable, running terminals with no description yet
 * are described.
 */
export class Murmur {
  private readonly descriptions: Descriptions
  // The gists of replies (see `changed`, `replied`).
  private readonly notes: Descriptions<NoteDigest, Note>
  private readonly watches = new Map<string, Watch>()
  private readonly times: MurmurTimes
  private readonly unwatch: () => void
  private readonly unwatchCleared: () => void
  // Unusable until the describer says otherwise: nothing is built or asked before.
  private usable = false

  constructor(
    describer: Describer,
    private readonly host: MurmurHost,
    times: Partial<MurmurTimes> = {},
  ) {
    this.times = { ...defaultTimes, ...times }
    this.descriptions = new Descriptions(describer)
    this.notes = new Descriptions<NoteDigest, Note>({
      describe: (digest, options) => describer.note(digest, options),
    })
    this.unwatch = describer.watchUsable((usable) => {
      this.usable = usable
      if (usable) this.catchUp()
      else {
        // What waited is dropped; a summary's title stays owed for the catch-up.
        this.descriptions.stop()
        this.notes.stop()
      }
    })
    this.unwatchCleared = describer.watchCleared(() => this.clear())
  }

  // The person turned murmur off or removed it: what was owed or asked is forgotten with
  // the titles, so turning it on later starts from a clean slate.
  private clear(): void {
    this.descriptions.stop()
    this.notes.stop()
    for (const watch of this.watches.values()) {
      clearTimeout(watch.retryTimer)
      this.resetNotes(watch)
      watch.named = null
      watch.owed = false
      watch.shellTitled = false
      watch.shellOwed = false
      watch.screenKey = null
    }
    try {
      this.host.cleared()
    } catch (error) {
      log.error("murmur.clear-failed", "Novadeck could not clear the terminals' murmur text", {
        err: error,
      })
    }
  }

  // What was asked for and owed of the gist is forgotten.
  private resetNotes(watch: Watch): void {
    clearTimeout(watch.noteRetry)
    watch.noteRetry = undefined
    watch.gist = null
    watch.gistOwed = false
  }

  // A gist that did not run is asked for again after `retryMs`.
  private retryNotes(terminalId: string, watch: Watch): void {
    clearTimeout(watch.noteRetry)
    watch.noteRetry = setTimeout(() => {
      watch.noteRetry = undefined
      // Unusable meanwhile: what is owed stays, for the catch-up once murmur is usable.
      if (!this.usable) return
      const at = watch.gistOwed ? watch.gist : null
      watch.gistOwed = false
      if (at !== null) {
        watch.gist = null
        this.replied(terminalId, at)
      }
      this.changed(terminalId)
    }, this.times.retryMs)
    watch.noteRetry.unref()
  }

  /** A terminal is gone or closed. */
  gone(terminalId: string): void {
    const watch = this.watches.get(terminalId)
    if (watch) {
      clearTimeout(watch.retryTimer)
      this.resetNotes(watch)
    }
    this.descriptions.cancel(terminalId)
    this.notes.forget(terminalId)
    this.watches.delete(terminalId)
  }

  stop(): void {
    this.unwatch()
    this.unwatchCleared()
    for (const watch of this.watches.values()) {
      clearTimeout(watch.retryTimer)
      this.resetNotes(watch)
    }
    this.descriptions.stop()
    this.notes.stop()
    this.watches.clear()
  }

  /**
   * An agent reported from the terminal: the run in the shell's foreground is the agent's
   * from here on, and its end owes the shell nothing. The sampler sees the foreground change
   * only when it does (the program the agent runs as stays the same all along), so it is
   * noted when the agent reports.
   */
  reported(terminalId: string): void {
    if (this.host.subject(terminalId)?.agent) this.watch(terminalId).agentRan = true
  }

  // The name a summary's title would replace: murmur's title, else its opening agent's. A
  // shell's title, which shows over the opener's, names what the shell did, not the agent's
  // work: then there is none to weigh, and the summary's title replaces it.
  private previousOf(subject: MurmurSubject, watch: Watch): string | undefined {
    const { murmur, agent } = subject.naming
    if (murmur !== null) return watch.shellTitled ? undefined : murmur.title
    return agent?.title
  }

  /**
   * The terminal's agent summarized its work: a summary that says something new names the
   * terminal. One that comes while murmur is unusable is owed until it is usable again.
   */
  summarized(terminalId: string): void {
    const subject = this.host.subject(terminalId)
    if (!subject?.agent || subject.naming.person !== null || !subject.naming.summary) return
    const watch = this.watch(terminalId)
    if (words(subject.naming.summary) === watch.named) return
    watch.owed = true
    if (this.usable) this.check(terminalId)
  }

  /** A plain shell's foreground program changed (sampled, so never on Windows). */
  sampled(terminalId: string): void {
    if (!this.usable) return
    const subject = this.host.subject(terminalId)
    if (!subject) return
    const watch = this.watch(terminalId)
    // An agent holds the foreground (noted as `agentRan` when it bound): its run is the
    // agent's, whatever program the sampler took it for before.
    if (subject.agent) return
    // The shell's own name is its prompt: no program.
    const key = subject.atPrompt ? null : programKey(subject.program)
    if (key === watch.program.key) return
    const ranMs = Date.now() - watch.program.since
    const was = watch.program.key
    watch.program = { key, since: Date.now() }
    // What waits is superseded by this change: a command that ended before it ran long
    // enough describes nothing, but a directory change or a catch-up still owed is asked
    // for again at the prompt.
    this.descriptions.withdraw(terminalId)
    // The prompt after a long run is owed a description until one is built, whatever holds
    // the foreground when the run ends: a brief program before the prompt (a prompt hook,
    // a status helper, or the shell caught between two processes) must not lose it, nor
    // must a run's own description still in flight.
    if (was !== null && ranMs >= this.times.shellRunMs && !watch.agentRan) watch.shellOwed = true
    watch.agentRan = false
    if (key === null) {
      if (watch.shellOwed) this.ask(terminalId, this.times.shellSettleMs)
      return
    }
    this.ask(terminalId, this.times.shellRunMs, { program: key })
  }

  /**
   * The terminal's agent activity changed: a job for a turn end that is no longer the last is
   * called off.
   */
  changed(terminalId: string): void {
    try {
      this.look(terminalId)
    } catch (error) {
      log.error("murmur.notes-failed", "Novadeck could not look at a terminal to write its notes", {
        err: error,
      })
    }
  }

  private look(terminalId: string): void {
    const subject = this.host.subject(terminalId)
    const watch = this.watches.get(terminalId)
    if (!watch) return
    const activity = subject?.agent ? subject.activity : null
    if (!activity) {
      this.forgetNotes(terminalId, watch)
      return
    }
    if (watch.gist !== null && !endedAt(activity, watch.gist)) {
      this.notes.cancel(gistKey(terminalId))
      watch.gist = null
      watch.gistOwed = false
    }
  }

  private forgetNotes(terminalId: string, watch: Watch): void {
    this.notes.forget(terminalId)
    this.resetNotes(watch)
  }

  /**
   * A client shows the turn end at `at` unread: its reply gets a gist once. Ignored while
   * murmur isn't usable.
   */
  replied(terminalId: string, at: number): void {
    if (!this.usable) return
    try {
      const subject = this.host.subject(terminalId)
      if (!subject?.agent || !subject.activity) return
      const watch = this.watch(terminalId)
      if (watch.gist === at || !endedAt(subject.activity, at)) return
      watch.gist = at
      this.notes.request(
        gistKey(terminalId),
        this.times.noteMs,
        () => this.replyDigestOf(terminalId, at),
        (outcome, digest) => {
          if (outcome === undefined) {
            // The describer did not run: the same end is asked for again in a while.
            if (digest && watch.gist === at) {
              watch.gistOwed = true
              this.retryNotes(terminalId, watch)
            }
          } else if (outcome?.kind === "gist") this.host.gisted(terminalId, at, outcome.text)
        },
        terminalId,
      )
    } catch (error) {
      log.error("murmur.gist-failed", "Novadeck could not look at a terminal to write its gist", {
        err: error,
      })
    }
  }

  // The reply that ended the turn at `at`, from its transcript; undefined once it is no longer the last.
  private async replyDigestOf(terminalId: string, at: number): Promise<NoteDigest | undefined> {
    if (!this.usable) return undefined
    const subject = this.host.subject(terminalId)
    if (!subject?.agent || !subject.transcript || !subject.activity) return undefined
    if (!endedAt(subject.activity, at)) return undefined
    const items = this.host.items(subject.agent)
    if (!items) return undefined
    const reply = await lastReply(subject.transcript, items)
    const now = this.host.subject(terminalId)?.activity
    if (reply === null || !now || !endedAt(now, at)) return undefined
    return replyDigest(reply, now.lastTurn?.outcome === "failed")
  }

  /**
   * A plain shell showed its prompt, after a command or none: it is described once its
   * quiet passes, unless nothing it is made from changed since the last description.
   */
  prompted(terminalId: string, entered = true): void {
    // A prompt no command was entered at (the first one, a redraw) has nothing new on screen.
    if (!this.usable || !entered) return
    const subject = this.host.subject(terminalId)
    if (!subject || subject.agent) return
    this.watch(terminalId).shellOwed = true
    this.ask(terminalId, this.times.shellSettleMs, { unchanged: true })
  }

  private watch(terminalId: string): Watch {
    let watch = this.watches.get(terminalId)
    if (!watch) {
      watch = {
        named: null,
        owed: false,
        shellTitled: false,
        retryTimer: undefined,
        program: { key: null, since: Date.now() },
        agentRan: false,
        shellOwed: false,
        screenKey: null,
        since: Date.now(),
        gist: null,
        gistOwed: false,
        noteRetry: undefined,
      }
      this.watches.set(terminalId, watch)
    }
    return watch
  }

  // Murmur became usable: terminals with no description yet get one.
  private catchUp(): void {
    let subjects: readonly MurmurSubject[] = []
    try {
      subjects = this.host.subjects()
    } catch (error) {
      log.error("murmur.list-failed", "Novadeck could not list the terminals to describe", {
        err: error,
      })
    }
    // One terminal that cannot be looked at leaves the others their turn.
    for (const subject of subjects) {
      try {
        this.catchUpOne(subject)
        this.catchUpNotes(subject.summary.id)
      } catch (error) {
        log.error("murmur.look-failed", "Novadeck could not look at a terminal to describe it", {
          err: error,
        })
      }
    }
  }

  // A reply without a gist is asked for again.
  private catchUpNotes(terminalId: string): void {
    const watch = this.watches.get(terminalId)
    if (watch) {
      const { gist } = watch
      this.resetNotes(watch)
      if (gist !== null) this.replied(terminalId, gist)
    }
    this.changed(terminalId)
  }

  private catchUpOne(subject: MurmurSubject): void {
    const id = subject.summary.id
    const watch = this.watch(id)
    if (subject.agent) {
      // A summary not named yet: one whose title did not run, or one of a terminal with no
      // title (as after murmur was turned off and on). A titled one waits for the next.
      const { naming } = subject
      const untitled = naming.murmur === null && naming.agent === null
      if (naming.person !== null || !naming.summary || words(naming.summary) === watch.named) return
      if (watch.owed || untitled) this.check(id)
      return
    }
    // A summary's title owed when the agent left is not the shell's.
    watch.owed = false
    if (subject.naming.murmur !== null) return
    watch.shellOwed = true
    this.ask(id, this.times.shellSettleMs)
  }

  /**
   * Names the agent's terminal from its summary after `settleMs`: the digest is built then,
   * so a burst of summaries makes one title.
   */
  private check(terminalId: string): void {
    const watch = this.watch(terminalId)
    clearTimeout(watch.retryTimer)
    watch.owed = true
    // The name the title would replace, as it was when the digest was built.
    let previous: string | undefined
    this.descriptions.request(
      terminalId,
      this.times.settleMs,
      async () => {
        // Nothing is built, read or serialized while murmur isn't usable.
        if (!this.usable) return undefined
        const subject = this.host.subject(terminalId)
        const summary = subject?.naming.summary
        if (!subject?.agent || subject.naming.person !== null || !summary) return undefined
        previous = this.previousOf(subject, watch)
        const projectFolder = this.host.projectFolder(subject.summary.sessionId)
        return {
          kind: "agent",
          project: projectFolder === undefined ? null : basename(projectFolder) || null,
          summary,
        }
      },
      (outcome, digest) => this.checked(terminalId, watch, outcome, digest, previous),
    )
  }

  /**
   * A summary's title came back. It replaces the name unless it shares a content word with
   * it, as a rewording of the same work. A refusal names nothing; one that did not run is
   * asked for again after `retryMs`.
   */
  private checked(
    terminalId: string,
    watch: Watch,
    outcome: Description | null | undefined,
    digest: Digest | undefined,
    previous: string | undefined,
  ): void {
    if (this.watches.get(terminalId) !== watch) return
    if (digest?.kind !== "agent") {
      // No digest was built: an agent that left, or a terminal the person titled, is owed
      // nothing; one that waits for murmur to be usable still is.
      const subject = this.host.subject(terminalId)
      if (!subject?.agent || subject.naming.person !== null) watch.owed = false
      return
    }
    if (outcome === undefined) {
      clearTimeout(watch.retryTimer)
      watch.retryTimer = setTimeout(() => {
        watch.retryTimer = undefined
        if (this.usable && watch.owed) this.check(terminalId)
      }, this.times.retryMs)
      watch.retryTimer.unref()
      return
    }
    // The agent left, or the person titled the terminal, while the model ran: nothing is
    // named, and clearing the person's title asks again.
    const now = this.host.subject(terminalId)
    if (!now?.agent || now.naming.person !== null) {
      watch.owed = false
      return
    }
    watch.named = words(digest.summary)
    // A newer summary that came while this one was named is still owed.
    watch.owed = words(now.naming.summary) !== watch.named
    if (outcome === null) return
    if (previous !== undefined && sharesContentWord(outcome.title, previous)) return
    if (this.store(terminalId, outcome.title)) watch.shellTitled = false
  }

  /**
   * Asks for a plain shell's description after `delayMs`. With a `program` key, it goes
   * only while that program still holds the foreground; `unchanged` drops it if what the
   * shell is described from is as at the last description.
   */
  private ask(
    terminalId: string,
    delayMs: number,
    options: { readonly program?: string; readonly unchanged?: boolean } = {},
  ): void {
    // A shell's request takes the terminal's one job from any summary's title waiting for
    // it, whose agent has left: nothing is owed of it. A shell opened to run an agent waits
    // for it to bind, or for the wait to pass.
    const mine = this.watches.get(terminalId)
    if (mine) mine.owed = false
    const subject = this.host.subject(terminalId)
    const wait = subject && !subject.agent ? this.expectedFor(subject) : 0
    let key: string | null = null
    this.descriptions.request(
      terminalId,
      Math.max(delayMs, wait),
      async () => {
        key = null
        // Nothing is built, read or serialized while murmur isn't usable.
        if (!this.usable) return undefined
        const current = this.host.subject(terminalId)
        if (!current || current.naming.person !== null) return undefined
        if (current.agent || this.expectedFor(current) > 0) return undefined
        if (options.program !== undefined && programKey(current.program) !== options.program)
          return undefined
        const built = await this.shellDigestOf(current, options.unchanged === true)
        key = built?.key ?? null
        return built?.digest
      },
      (outcome) => {
        // Described, or refused: what it was made from is not made into a description again.
        if (outcome !== undefined && key !== null) this.watch(terminalId).screenKey = key
        this.shellSettled(terminalId, outcome)
      },
    )
  }

  // How much longer a shell opened to run an agent waits for it to bind, in milliseconds.
  private expectedFor(subject: MurmurSubject): number {
    if (!subject.expecting) return 0
    const since = this.watch(subject.summary.id).since
    return Math.max(0, this.times.expectMs - (Date.now() - since))
  }

  private async shellDigestOf(
    subject: MurmurSubject,
    unchanged: boolean,
  ): Promise<{ digest: Digest; key: string } | undefined> {
    const screen = await this.host.screen(subject.summary.id)
    const now = this.host.subject(subject.summary.id)
    if (!screen || !now || now.agent) return undefined
    const watch = this.watch(subject.summary.id)
    const command = commandOf(now.program, now.atPrompt)
    const alternate = screen.alternate === true
    const key = screenKey(now.summary.cwd, command, screen.rows, alternate)
    // Described, or at least looked at: nothing is owed of it.
    watch.shellOwed = false
    if (unchanged && key === watch.screenKey) return undefined
    const digest = shellDigest({
      projectFolder: this.host.projectFolder(now.summary.sessionId),
      command,
      rows: screen.rows,
      alternate,
      ...(screen.commandRow !== undefined && { commandRow: screen.commandRow }),
      ...(screen.wrapped && { wrapped: screen.wrapped }),
      ...(screen.continues && { rowContinues: screen.continues }),
    })
    if (!digest) return undefined
    // A bare prompt with nothing typed after it (the last command's line is a prompt like
    // the one at the bottom, or every row is) says nothing new: an empty Enter, Ctrl+L or a
    // line typed and erased. It is skipped, not refused.
    if (command === null && bare(digest)) return undefined
    return { digest, key }
  }

  // A shell's job ended: its title, if it got one, names the terminal.
  private shellSettled(terminalId: string, outcome: Description | null | undefined): void {
    if (!outcome || !this.store(terminalId, outcome.title)) return
    // An agent that starts in this shell, or after the one that left it, is named from its
    // own summary, even one that says what the last agent's did; nothing is owed meanwhile.
    const watch = this.watches.get(terminalId)
    if (!watch) return
    watch.named = null
    watch.owed = false
    watch.shellTitled = true
  }

  // A title came back: it names the terminal if it can be one and the person gave it none;
  // true when it does.
  private store(terminalId: string, title: string): boolean {
    const text = title.trim()
    if (!terminalTitle.safeParse(text).success) return false
    if (this.host.subject(terminalId)?.naming.person) return false
    this.host.described(terminalId, { title: text })
    return true
  }
}

/** Whether the activity's last turn ended at `at`, completed or failed, with none running and no gist yet. */
const endedAt = (activity: Activity, at: number): boolean =>
  activity.state !== "working" &&
  activity.lastTurn?.at === at &&
  (activity.lastTurn.outcome === "completed" || activity.lastTurn.outcome === "failed") &&
  activity.lastTurn.gist === undefined
