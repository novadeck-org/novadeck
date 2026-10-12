import { basename, isAbsolute, relative, sep } from "node:path"

import { terminalTitle, type AgentName, type ForegroundProcess } from "@novadeck/protocol"

import type { Activity } from "../harnesses/activity.js"
import { tailLines } from "../harnesses/follow.js"
import type { Items } from "../harnesses/replies.js"
import { agentLabel } from "../messaging/mailbox.js"
import type {
  AgentDigest,
  Describer,
  Description,
  Digest,
  Previous,
  ShellDigest,
} from "../murmur/describer.js"
import type { Facts } from "./nudges.js"
import type { PeerTerminal } from "./peers.js"
import { busiestFolders, promptChars, shorten, type Work } from "./work.js"

/*
 * When a terminal is described by murmur, and from what (see docs/agent-messaging.md,
 * "Naming"). The terminals own the triggers, the digests and the coalescing; the service
 * behind the `Describer` owns the model, its prompt, redaction and validation.
 */

/** The waits and counts that decide when murmur describes; tests shorten them. */
export type MurmurTimes = {
  /**
   * How long an agent terminal's trigger waits for quiet before it describes, in
   * milliseconds, so a burst (a prompt, then the turn's end) makes one description, and
   * the reply is written to the transcript by then.
   */
  readonly settleMs: number
  /**
   * How long a plain shell's program must have run before its change describes: a
   * command that ends sooner (`ls`, `git status`) never does.
   */
  readonly shellRunMs: number
  /** How long a plain shell's change of directory waits for quiet. */
  readonly shellSettleMs: number
  /**
   * How long a shell opened to run an agent is not described as a shell, while the agent
   * may yet bind, in milliseconds.
   */
  readonly expectMs: number
  /**
   * How long a title that could not be asked for (murmur off, backed off or busy: it did
   * not run) waits before the same mission is asked again, in milliseconds, with no digest
   * built meanwhile.
   */
  readonly retryMs: number
}

export const defaultTimes: MurmurTimes = {
  settleMs: 3_000,
  shellRunMs: 5_000,
  shellSettleMs: 3_000,
  expectMs: 10_000,
  retryMs: 60_000,
}

// These are generous safety caps only. The service redacts every string before it cuts
// any, so a cap here must never cut a secret in half ahead of the redaction; it applies
// the caps the model is shown (the reply's last 1500 characters, a screen of the last
// few rows) afterwards.

/** How much of the agent's last reply is passed on, in characters, from its end. */
export const replyChars = 3000
/** How many logical lines of a plain shell's screen, how long each; the lowest lines win. */
export const screenRows = 100
export const screenColumns = 8000
/** The longest command line passed on. */
export const commandChars = 2000

// Characters no reply or screen row shows to a model: C0 and C1 control characters, and DEL.
// eslint-disable-next-line no-control-regex -- These are the characters it removes.
const control = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
// eslint-disable-next-line no-control-regex -- Escape sequences, whole.
const escapes = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/** The last segment or two of a path, as a place is named. */
export const placeName = (path: string): string => {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.slice(-2).join("/") || path
}

/** `text` cut to its last `max` characters (code points), with an ellipsis where it was cut. */
export const tailOf = (text: string, max: number): string => {
  const characters = [...text]
  return characters.length > max ? `…${characters.slice(-(max - 1)).join("")}` : text
}

/**
 * The tail of what the agent said last since the person's latest prompt and its latest
 * tool step, as its transcript records it, through its harness's items; null when it
 * said nothing since or the transcript can't be read. Words before a tool call are its
 * working notes, not its reply. Only the end of the transcript is read.
 */
export const replyTail = async (
  path: string,
  items: Items,
  chars = replyChars,
): Promise<string | null> => {
  const lines = await tailLines(path)
  let reply: string | undefined
  for (const line of lines ?? [])
    for (const { role, kind, text } of items(line)) {
      if (role === "user" || role === "tool" || kind === "tool-call") reply = undefined
      else if (role === "assistant" && kind === "text" && text.trim()) reply = text
    }
  if (reply === undefined) return null
  const clean = reply.replace(escapes, "").replace(control, " ").trim()
  return clean ? tailOf(clean, chars) : null
}

/** A folder as murmur is shown it: inside the project, relative to it; else its last segments. */
const shownFolder = (folder: string, projectFolder: string | undefined): string => {
  if (projectFolder !== undefined) {
    const inside = relative(projectFolder, folder)
    if (!inside) return "."
    // Always "/"-separated: the model reads the same digest on every platform.
    if (!inside.startsWith("..") && !isAbsolute(inside)) return inside.split(sep).join("/")
  }
  return placeName(folder)
}

// The words of greetings, thanks, acknowledgements, chat and small talk, in English, Polish
// and Korean (which uses spaces). A prompt made of nothing else says nothing of what a
// terminal is for; one with a single word beyond them ("fix", "login", "deploy") does.
const filler = new Set(
  `hi hey hello hiya howdy yo greetings thanks thank you thx ty cheers ok okay k kk yes yeah yep
  yup no nope nah sure fine good great nice cool awesome perfect lovely sounds right got it go on
  continue proceed please pls do that this the other one a an and so then now again try retry
  more next sorry bye goodbye lgtm done how are is going what s up whats sup hows doing u ur me
  there everyone all for with your my well just very really much lot lots can could would will
  help i m im am back today again morning evening afternoon night
  cześć czesc hej heja siema witam witaj dzień dzien dobry dobra dobrze dzięki dzieki dziękuję
  dziekuje dziękuje super świetna swietna świetnie swietnie świetny swietny robota spoko git jak
  leci co tam słychać slychac u ciebie ty proszę prosze dalej kontynuuj jeszcze raz znowu pa do
  widzenia nara tak nie jasne jasno okej to ten ta inne inny drugi drugie jedno i a w porządku
  porzadku się sie jest tu zrób zrob spróbuj sprobuj możesz mozesz mi pomóc pomoc pomocy mogę
  moge wróciłem wrocilem jestem
  안녕 안녕하세요 안녕히 감사합니다 고맙습니다 고마워요 감사해요 네 예 아니요 좋아요 알겠습니다
  반갑습니다 잘 부탁드립니다 부탁해요 죄송합니다`.split(/\s+/),
)

// Greetings and thanks of the scripts written without spaces (Japanese, Chinese, Thai),
// which a prompt of nothing else is.
const spacelessFiller =
  `こんにちは こんばんは おはようございます おはよう ありがとうございました ありがとうございます
  ありがとう よろしくお願いします よろしく お願いします お疲れ様です お疲れさまです お疲れ様 すみません
  ごめんなさい はい ええ いいえ
  你好吗 你好 您好 谢谢您 谢谢你 谢谢 多谢 好的 早上好 晚上好 再见 嗯 好
  สวัสดีครับ สวัสดีค่ะ สวัสดี ขอบคุณครับ ขอบคุณค่ะ ขอบคุณ ครับ ค่ะ โอเค ได้`
    .split(/\s+/)
    .toSorted((a, b) => b.length - a.length)

// A stretch of nothing but those greetings.
const spacelessGreeting = new RegExp(`^(?:${spacelessFiller.join("|")})+$`, "u")

/**
 * Whether a prompt says what a terminal is for: at least three words (or four characters
 * of a script written without spaces), and not wholly a greeting, thanks, acknowledgement,
 * chat or small talk ("hey, how's it going", "sounds good, thanks!", "can you help me",
 * "こんにちは"). A prompt that merely starts with such a word ("test the login flow", "ok fix
 * the tests") is one.
 */
export const substantial = (prompt: string): boolean => {
  const text = prompt.normalize("NFKC").toLowerCase()
  // Scripts written without spaces between words (Chinese, Japanese, Thai) have no words
  // to count: four characters of them say as much as three words, unless they are all
  // greetings. Korean has spaces, and goes by its words. A greeting is a whole stretch
  // between punctuation or spaces; it is never taken out from inside a word ("修好测试").
  const script = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/gu
  if ((text.match(script)?.length ?? 0) >= 4) {
    const rest = text
      .split(/[\p{P}\p{S}\s]+/u)
      .filter((stretch) => stretch && !spacelessGreeting.test(stretch))
      .join("")
    if ((rest.match(script)?.length ?? 0) >= 4) return true
  }
  const words = text.replace(script, " ").match(/[\p{L}\p{N}]+/gu) ?? []
  if (words.length < 3) return false
  return !words.every((word) => filler.has(word))
}

/** The prompts murmur is shown, oldest first: the first the person gave, if it left the recent ones. */
export const promptsOf = (work: Work | null): readonly string[] => {
  if (!work) return []
  const recent = work.recent.length > 0 ? work.recent : work.latest ? [work.latest] : []
  const first =
    work.first !== null && !recent.some((prompt) => shorten(prompt, promptChars) === work.first)
      ? [work.first]
      : []
  return [...first, ...recent]
}

/** What murmur is shown of an agent's terminal; null when neither a summary nor a prompt tells what it is for. */
export const agentDigest = (input: {
  readonly harness: AgentName
  readonly projectFolder: string | undefined
  readonly cwd: string
  readonly branch: string | null
  readonly plan: string | null
  readonly work: Work | null
  readonly reply: string | null
  /** What the terminal's own agent last said it works on, through `summarize`. */
  readonly summary: string | null
  readonly previous: Previous
}): AgentDigest | null => {
  // Without the agent's summary, a terse prompt would become the title as it is: it is
  // titled from the first substantial prompt, its mission, alone.
  const all = promptsOf(input.work)
  const mission = all.find(substantial)
  const prompts = input.summary ? all : mission === undefined ? [] : [mission]
  // A summary of the current session says enough with no prompt yet.
  if (prompts.length === 0 && !input.summary) return null
  const { projectFolder } = input
  return {
    kind: "agent",
    harness: agentLabel(input.harness),
    project: projectFolder === undefined ? null : basename(projectFolder) || null,
    folder: placeName(input.cwd),
    branch: input.branch,
    plan: input.plan,
    folders: busiestFolders(input.work?.folders ?? {}, 3).map(({ folder }) =>
      shownFolder(folder, projectFolder),
    ),
    prompts,
    reply: input.reply,
    summary: input.summary,
    previous: input.previous,
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
 */
export const screenLines = (
  rows: readonly string[],
  wrapped: readonly boolean[] = [],
  rowContinues: readonly boolean[] = [],
): { readonly screen: readonly string[]; readonly continues: readonly boolean[] } => {
  const lines: string[] = []
  const ends: boolean[] = []
  rows.forEach((row, index) => {
    if (wrapped[index] && lines.length > 0) lines[lines.length - 1] += row
    else lines.push(row)
    ends[lines.length - 1] = rowContinues[index] ?? false
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
  return { screen: kept.slice(from), continues: ends.slice(from, kept.length) }
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
  readonly cwd: string
  readonly command: string | null
  readonly rows: readonly string[]
  /** Which rows continue the one before, as the terminal wrapped a long line. */
  readonly wrapped?: readonly boolean[]
  /** Which of the screen's rows are drawn full across it (see `screenLines`). */
  readonly rowContinues?: readonly boolean[]
  readonly previous: Previous
  /**
   * A full-screen program (vim, less, htop, tmux) has the screen: what it draws is not
   * shown, so the digest has the program's command, folder and project alone, and none at
   * all when the command is not known (the title stays as it is).
   */
  readonly alternate?: boolean
}): ShellDigest | null => {
  const { screen, continues } = input.alternate
    ? { screen: [], continues: [] }
    : screenLines(input.rows, input.wrapped, input.rowContinues)
  if (input.command === null && screen.length < 2) return null
  const { projectFolder } = input
  return {
    kind: "shell",
    project: projectFolder === undefined ? null : basename(projectFolder) || null,
    folder: placeName(input.cwd),
    command: input.command,
    screen,
    ...(input.rowContinues && { continues }),
    previous: input.previous,
  }
}

type Job = {
  readonly id: string
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
export class Descriptions {
  private readonly jobs = new Map<string, Job>()

  constructor(private readonly describer: Describer) {}

  /** Whether a request waits or a job runs for the terminal. */
  busy(id: string): boolean {
    const job = this.jobs.get(id)
    return job !== undefined && (job.timer !== undefined || job.running)
  }

  /**
   * Asks for the terminal's description once `delayMs` pass without another request.
   * `build` makes the digest (undefined for none, as when the terminal is gone) and
   * `done` takes the outcome: the description murmur wrote; null when it ran and refused a
   * title; undefined when it did not run (off, backed off, busy, dropped), or no digest could
   * be built. An aborted or superseded job reports nothing.
   */
  request(
    id: string,
    delayMs: number,
    build: () => Promise<Digest | undefined>,
    done: (outcome: Description | null | undefined, digest: Digest | undefined) => void,
  ): void {
    const job = this.jobs.get(id) ?? {
      id,
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

  stop(): void {
    for (const id of this.jobs.keys()) this.cancel(id)
  }

  private async run(
    job: Job,
    build: () => Promise<Digest | undefined>,
    done: (outcome: Description | null | undefined, digest: Digest | undefined) => void,
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
        terminal: job.id,
      })
      if (job.latest === mine && !controller.signal.aborted) done(outcome, digest)
    } catch (error) {
      console.error("Novadeck could not describe a terminal:", error)
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

/** What a terminal's agent report tells murmur, as the terminal manager reads it. */
export type Reported = {
  /** The root session is a new one. */
  readonly session: boolean
  /** Root sessions whose id was corrected (Antigravity's guess), as `agent:session`. */
  readonly corrected?: readonly { readonly from: string; readonly to: string }[]
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
  /** The terminal's plan, busiest folder and branch: what drift is told by and the digest shows. */
  facts(subject: MurmurSubject): Promise<Facts>
  /** The visible rows of the terminal's screen, and which of them the terminal wrapped. */
  screen(terminalId: string): Promise<
    | {
        readonly rows: readonly string[]
        readonly wrapped?: readonly boolean[]
        readonly continues?: readonly boolean[]
        /** Whether a full-screen program has the screen (the alternate buffer). */
        readonly alternate?: boolean
      }
    | undefined
  >
  /** The harness's reader of its transcript's lines. */
  items(agent: AgentName): Items | undefined
  projectFolder(sessionId: string): string | undefined
  /** Gives the terminal murmur's description; nothing when it is gone. */
  described(terminalId: string, description: Description): void
  /** Murmur was turned off or removed: every terminal loses its murmur title, saved ones too. */
  cleared(): void
}

// What murmur keeps of a terminal between triggers; lost with the runner.
type Watch = {
  /** A title is owed once a prompt or a summary says what the terminal is for (a new session). */
  owed: boolean
  /** The mission (summary or prompt) last asked for, so it isn't asked for again unchanged. */
  tried: string | null
  /**
   * The root session the agent's summary was written in (as `work.session`); undefined when
   * unknown, as after a runner restart. A summary of an earlier session says nothing of
   * this one's mission.
   */
  summarySession: string | null | undefined
  /** Until when a mission that could not be asked for waits to be asked again. */
  retryAt: number
  /** The timer that asks again then, for a terminal that sends no reports meanwhile. */
  retryTimer: NodeJS.Timeout | undefined
  /** The program in a plain shell's foreground, as a key, and since when; null at the prompt. */
  program: { readonly key: string | null; readonly since: number }
  /** A shell's description is owed (its directory changed, or it has none yet) and not built. */
  shellOwed: boolean
  /** When murmur first looked at the terminal, from which an expected agent is waited for. */
  since: number
}

const programKey = (program: ForegroundProcess | null): string | null =>
  program === null ? null : JSON.stringify([program.name, program.argv])

/**
 * Decides when each terminal is described and what from, and hands the result to the
 * manager. Without a describer, nothing happens.
 *
 * An agent's terminal is titled once, after the person's first substantial prompt of a root
 * session (its mission; not "hey!" nor "try again"), or its agent's first summary, and then
 * on every `summarize` call, whose summary is the main input. A compaction, drift or later
 * prompts nudge the agent to summarize instead, so murmur never retitles from a bare terse
 * prompt. A plain shell's: when the program in its foreground changed, once it has run
 * `shellRunMs`; when it returns to the prompt after such a run; and when its directory
 * changed. The foreground is sampled only where the platform tells it, so on Windows
 * only the directory triggers. When murmur becomes usable, running terminals with no
 * description yet are described.
 */
export class Murmur {
  private readonly descriptions: Descriptions
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
    this.unwatch = describer.watchUsable((usable) => {
      this.usable = usable
      if (usable) this.catchUp()
      else this.descriptions.stop()
    })
    this.unwatchCleared = describer.watchCleared(() => this.clear())
  }

  // The person turned murmur off or removed it: what was owed or asked is forgotten with
  // the titles, so turning it on later starts from a clean slate.
  private clear(): void {
    this.descriptions.stop()
    for (const watch of this.watches.values()) {
      this.resetRetry(watch)
      watch.owed = false
      watch.tried = null
      watch.shellOwed = false
    }
    try {
      this.host.cleared()
    } catch (error) {
      console.error("Novadeck could not clear the terminals' murmur titles:", error)
    }
  }

  private resetRetry(watch: Watch): void {
    clearTimeout(watch.retryTimer)
    watch.retryTimer = undefined
    watch.retryAt = 0
  }

  /** A terminal is gone or closed. */
  gone(terminalId: string): void {
    const watch = this.watches.get(terminalId)
    if (watch) this.resetRetry(watch)
    this.descriptions.cancel(terminalId)
    this.watches.delete(terminalId)
  }

  stop(): void {
    this.unwatch()
    this.unwatchCleared()
    for (const watch of this.watches.values()) this.resetRetry(watch)
    this.descriptions.stop()
    this.watches.clear()
  }

  /** An agent's report, as the manager read it for the terminal's root session. */
  reported(terminalId: string, told: Reported): void {
    try {
      this.react(terminalId, told)
    } catch (error) {
      console.error("Novadeck could not look at a terminal to describe it:", error)
    }
  }

  private react(terminalId: string, told: Reported): void {
    const subject = this.host.subject(terminalId)
    if (!subject?.agent) return
    const watch = this.watch(terminalId)
    // A corrected root session carries its summary over.
    for (const { from, to } of told.corrected ?? [])
      if (watch.summarySession === from) watch.summarySession = to
    // A new session is owed a title whether murmur can write one now or not.
    if (told.session) {
      watch.owed = true
      watch.tried = null
      this.resetRetry(watch)
    }
    if (!this.usable) return
    // The title waits for a prompt to say what the terminal is for (its mission) or for the
    // agent's first summary; one in the making is not asked for again at each report. Once
    // it is titled, only a summary retitles it: never a bare terse prompt, a compaction or
    // a drift, which nudge the agent to summarize instead.
    // A mission is asked for once, whatever comes of it: a title murmur rejected, or never
    // gave as it was busy, isn't asked for again at every report, but when something new
    // arrives (a summary, a new session, or other words for the mission).
    const mission = this.missionOf(subject)
    if (
      (watch.owed || subject.naming.murmur === null) &&
      mission !== undefined &&
      mission !== watch.tried &&
      Date.now() >= watch.retryAt &&
      !this.descriptions.busy(terminalId)
    ) {
      watch.owed = false
      watch.tried = mission
      this.ask(terminalId, this.times.settleMs)
    }
  }

  // The agent's summary, if it was written in the root session now running; one of an
  // earlier session (before a /clear) says nothing of this one. Where it was written is
  // unknown after a runner restart, and then it is not taken for the mission: the next
  // `summarize`, which the new session's nudge asks for, is.
  private currentSummary(subject: MurmurSubject): string | null {
    const { summary } = subject.naming
    if (!summary) return null
    const session = subject.work?.session ?? null
    const written = this.watch(subject.summary.id).summarySession
    return written !== undefined && written === session ? summary : null
  }

  // What the terminal can be titled from: its agent's current summary, else the first
  // substantial prompt it was given; undefined while it has neither.
  private missionOf(subject: MurmurSubject): string | undefined {
    return this.currentSummary(subject) ?? promptsOf(subject.work).find(substantial)
  }

  /**
   * The terminal's agent summarized its work: its latest summary is the strongest thing
   * murmur has to title it by, so it looks again, as after any trigger.
   */
  summarized(terminalId: string): void {
    const subject = this.host.subject(terminalId)
    if (!subject?.agent) return
    const watch = this.watch(terminalId)
    // Where the summary was written counts whether murmur can use it now or not.
    watch.summarySession = subject.work?.session ?? null
    // A summary murmur could not use is owed a retitle once it can.
    if (!this.usable) {
      watch.owed = true
      watch.tried = null
      return
    }
    watch.tried = subject.naming.summary
    this.ask(terminalId, this.times.settleMs)
  }

  /** A plain shell's foreground program changed (sampled, so never on Windows). */
  sampled(terminalId: string): void {
    if (!this.usable) return
    const subject = this.host.subject(terminalId)
    if (!subject || subject.agent) return
    const watch = this.watch(terminalId)
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
    if (was !== null && ranMs >= this.times.shellRunMs) watch.shellOwed = true
    if (key === null) {
      if (watch.shellOwed) this.ask(terminalId, this.times.shellSettleMs)
      return
    }
    this.ask(terminalId, this.times.shellRunMs, key)
  }

  /** A plain shell showed its prompt in another directory. */
  moved(terminalId: string): void {
    if (!this.usable) return
    const subject = this.host.subject(terminalId)
    if (!subject || subject.agent) return
    this.watch(terminalId).shellOwed = true
    this.ask(terminalId, this.times.shellSettleMs)
  }

  private watch(terminalId: string): Watch {
    let watch = this.watches.get(terminalId)
    if (!watch) {
      watch = {
        owed: false,
        tried: null,
        summarySession: undefined,
        retryAt: 0,
        retryTimer: undefined,
        program: { key: null, since: Date.now() },
        shellOwed: false,
        since: Date.now(),
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
      console.error("Novadeck could not list the terminals to describe:", error)
    }
    // One terminal that cannot be looked at leaves the others their turn.
    for (const subject of subjects) {
      try {
        this.catchUpOne(subject)
      } catch (error) {
        console.error("Novadeck could not look at a terminal to describe it:", error)
      }
    }
  }

  private catchUpOne(subject: MurmurSubject): void {
    // A titled terminal is described again only if a retitle is owed it (a summary's
    // that did not run, whose timer found murmur unusable).
    if (subject.naming.murmur !== null) {
      const watch = this.watches.get(subject.summary.id)
      if (subject.agent && watch?.owed && watch.tried === null)
        this.react(subject.summary.id, { session: false })
      return
    }
    const mission = subject.agent ? this.missionOf(subject) : undefined
    if (subject.agent && mission === undefined) {
      this.watch(subject.summary.id).owed = true
      return
    }
    const watch = this.watch(subject.summary.id)
    if (mission !== undefined) watch.tried = mission
    if (!subject.agent) watch.shellOwed = true
    this.ask(subject.summary.id, subject.agent ? this.times.settleMs : this.times.shellSettleMs)
  }

  /**
   * Asks for the terminal's description after `delayMs`. A plain shell's, with the key of
   * the program it was asked for, goes only while that program still holds the foreground.
   */
  private ask(terminalId: string, delayMs: number, program?: string): void {
    // A shell opened to run an agent waits for it to bind, or for the wait to pass.
    const subject = this.host.subject(terminalId)
    const wait = subject && !subject.agent ? this.expectedFor(subject) : 0
    this.descriptions.request(
      terminalId,
      Math.max(delayMs, wait),
      async () => {
        // Nothing is built, read or serialized while murmur isn't usable.
        if (!this.usable) return undefined
        const current = this.host.subject(terminalId)
        if (!current) return undefined
        if (!current.agent && this.expectedFor(current) > 0) return undefined
        if (program !== undefined && programKey(current.program) !== program) return undefined
        return current.agent ? this.agentDigestOf(current) : this.shellDigestOf(current)
      },
      (outcome) => this.settled(terminalId, outcome),
    )
  }

  // How much longer a shell opened to run an agent waits for it to bind, in milliseconds.
  private expectedFor(subject: MurmurSubject): number {
    if (!subject.expecting) return 0
    const since = this.watch(subject.summary.id).since
    return Math.max(0, this.times.expectMs - (Date.now() - since))
  }

  // The digest an agent's terminal is described from, and the facts it is built on.
  private async agentDigestOf(subject: MurmurSubject): Promise<Digest | undefined> {
    const id = subject.summary.id
    const agent = subject.agent!
    const [facts, reply] = await Promise.all([this.host.facts(subject), this.replyOf(subject)])
    // Read again after waiting: the terminal may have moved on or gone.
    const now = this.host.subject(id)
    if (!now?.agent) return undefined
    const digest = agentDigest({
      harness: agent,
      projectFolder: this.host.projectFolder(now.summary.sessionId),
      cwd: now.summary.cwd,
      branch: facts.branch,
      plan: facts.plan,
      work: now.work,
      reply,
      summary: this.currentSummary(now),
      previous: now.naming.murmur,
    })
    if (!digest) return undefined
    return digest
  }

  /**
   * The tail of the agent's last reply: from its transcript, up to `replyChars`; else, where
   * its harness tells no transcript's items, the preview its turn's end reported (a
   * hundred or so characters), only once the turn is over.
   */
  private async replyOf(subject: MurmurSubject): Promise<string | null> {
    const items = subject.agent ? this.host.items(subject.agent) : undefined
    if (items && subject.transcript) return replyTail(subject.transcript, items)
    return finishedReply(subject.activity)
  }

  private async shellDigestOf(subject: MurmurSubject): Promise<Digest | undefined> {
    const screen = await this.host.screen(subject.summary.id)
    const now = this.host.subject(subject.summary.id)
    if (!screen || !now || now.agent) return undefined
    this.watch(subject.summary.id).shellOwed = false
    return (
      shellDigest({
        projectFolder: this.host.projectFolder(now.summary.sessionId),
        cwd: now.summary.cwd,
        command: commandOf(now.program, now.atPrompt),
        rows: screen.rows,
        alternate: screen.alternate === true,
        ...(screen.wrapped && { wrapped: screen.wrapped }),
        ...(screen.continues && { rowContinues: screen.continues }),
        previous: now.naming.murmur,
      }) ?? undefined
    )
  }

  // A job ended. A refusal (null) closes the mission; murmur not running (undefined) leaves
  // it owed, to be asked for again after `retryMs`; a title names the terminal.
  private settled(terminalId: string, outcome: Description | null | undefined): void {
    if (outcome === undefined) {
      const watch = this.watches.get(terminalId)
      if (watch && watch.tried !== null) {
        watch.tried = null
        // Owed again, though the terminal has a title already: a summary's retitle that
        // did not run is not lost.
        watch.owed = true
        watch.retryAt = Date.now() + this.times.retryMs
        // An idle terminal sends no reports to ask again at: a timer does, once.
        clearTimeout(watch.retryTimer)
        watch.retryTimer = setTimeout(() => {
          watch.retryTimer = undefined
          this.reported(terminalId, { session: false })
        }, this.times.retryMs)
        watch.retryTimer.unref()
      }
      return
    }
    if (outcome) this.stored(terminalId, outcome)
  }

  // A description came back: it names the terminal if its title can be one.
  private stored(terminalId: string, description: Description): void {
    const watch = this.watches.get(terminalId)
    if (watch) this.resetRetry(watch)
    const title = description.title.trim()
    if (!terminalTitle.safeParse(title).success) return
    this.host.described(terminalId, { title })
  }
}

/** The preview of the agent's last reply, when its turn is over. */
const finishedReply = (activity: Activity | null): string | null =>
  activity && activity.state !== "working" ? (activity.lastTurn?.reply ?? null) : null
