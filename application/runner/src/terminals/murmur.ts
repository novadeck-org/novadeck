import { createHash } from "node:crypto"
import { basename, isAbsolute, relative, sep } from "node:path"

import { tailLines } from "@novadeck/harness-core/follow"
import { terminalTitle, type AgentName, type ForegroundProcess } from "@novadeck/protocol"

import type { Activity, Request } from "../harnesses/activity.js"
import type { Items } from "../harnesses/replies.js"
import { agentLabel } from "../messaging/mailbox.js"
import type {
  AgentDigest,
  Describer,
  Description,
  Digest,
  Note,
  NoteDigest,
  PlanDigest,
  Previous,
  QuestionDigest,
  ReplyDigest,
  ShellDigest,
} from "../murmur/describer.js"
import { sharesContentWord } from "../murmur/description.js"
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
   * How long a settled agent terminal waits between two checks of its name, in
   * milliseconds, counted from the last check. Evidence that arrives inside the gap does
   * not check at once but sets one timer for when the gap ends; a hard signal (a new
   * summary, a changed branch or plan) ignores the gap.
   */
  readonly settledGapMs: number
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
   * How long a title that could not be asked for (murmur off, backed off or busy: it did
   * not run) waits before the same mission is asked again, in milliseconds, with no digest
   * built meanwhile.
   */
  readonly retryMs: number
  /** How long a headline or a gist waits before it is asked for, in milliseconds. */
  readonly noteMs: number
}

export const defaultTimes: MurmurTimes = {
  settleMs: 3_000,
  settledGapMs: 5 * 60_000,
  shellRunMs: 5_000,
  shellSettleMs: 3_000,
  expectMs: 10_000,
  retryMs: 60_000,
  noteMs: 1_000,
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
/** How much of a plan's file is read for a headline, in bytes. */
export const planBytes = 16 * 1024
/** How many answers of a question are shown, and how much of a reply: its first and last characters. */
export const choiceCount = 16
export const replyHeadChars = 4000
export const replyTailChars = 4000

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

/** The tail of `lastReply`, up to `chars` characters; null when there is none. */
export const replyTail = async (
  path: string,
  items: Items,
  chars = replyChars,
): Promise<string | null> => {
  const reply = await lastReply(path, items)
  return reply === null ? null : tailOf(reply, chars)
}

/** What murmur is shown of a question; null when the request has no subject. */
export const questionDigest = (request: Request): QuestionDigest | null =>
  request.subject
    ? {
        kind: "question",
        question: request.subject,
        choices: request.choices.slice(0, choiceCount),
      }
    : null

/** What murmur is shown of a plan, its first 16 KiB; null when it is empty. */
export const planDigest = (text: string): PlanDigest | null =>
  text.trim() ? { kind: "plan", plan: text.slice(0, planBytes) } : null

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

/**
 * The person's latest prompt that says what the terminal is for (see `substantial`); null
 * when none does. What the last check was made against, so a prompt is new evidence once
 * it differs.
 */
export const latestPrompt = (work: Work | null): string | null =>
  promptsOf(work).findLast(substantial) ?? null

/**
 * What murmur is shown of an agent's terminal; null when neither a summary nor a
 * substantial prompt tells what it is for.
 */
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
  /** Where the terminal's name stands (see `AgentDigest.stage`). */
  readonly stage: AgentDigest["stage"]
}): AgentDigest | null => {
  // A title names the session's goal, which a terse prompt ("ok", "go on") does not
  // state but an earlier one does: the substantial prompts are shown, the first and the
  // recent ones, and pure filler is dropped.
  const prompts = promptsOf(input.work).filter(substantial)
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
    stage: input.stage,
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
  readonly cwd: string
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
  readonly previous: Previous
  /**
   * A full-screen program (vim, less, htop, tmux) has the screen: what it draws is not
   * shown, so the digest has the program's command, folder and project alone, and none at
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
    folder: placeName(input.cwd),
    command: input.command,
    screen,
    ...(input.rowContinues && { continues }),
    ...(at !== undefined && { commandAt: at }),
    previous: input.previous,
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

  /** Whether a request waits or a job runs for the terminal. */
  busy(id: string): boolean {
    const job = this.jobs.get(id)
    return job !== undefined && (job.timer !== undefined || job.running)
  }

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
  /** Gives the oldest question or plan asked as `request` its headline; nothing when it no longer waits. */
  headlined(
    terminalId: string,
    request: { readonly requestId: string; readonly askedAt: number },
    text: string,
  ): void
  /** Gives the terminal's turn end at `at` its gist; nothing when that is no longer its last. */
  gisted(terminalId: string, at: number, gist: { text: string; asks: boolean }): void
  /** Up to 16 KiB of the start of a regular file; null on any error. */
  fileHead(path: string): Promise<string | null>
  /** Murmur was turned off or removed: every terminal loses its murmur title, saved ones too, and its headlines and gists. */
  cleared(): void
}

/** What a check of an agent terminal's name was made against: the evidence it has seen. */
type Marks = {
  /** The latest substantial prompt shown, as `latestPrompt` tells it; null before any. */
  readonly prompt: string | null
  /** The summary shown. */
  readonly summary: string | null
  /** When the digest was built, from which the settled gap runs; 0 before any. */
  readonly at: number
  /** Whether any check of this session was made. */
  readonly started: boolean
}

/** How many checks in a row that keep the name end the forming stage, and the most checks it lasts. */
const keepsToSettle = 2
const formingChecks = 4

// What murmur keeps of a terminal between triggers; lost with the runner.
type Watch = {
  /**
   * Where an agent terminal's name stands. `forming`: the session's work is still taking
   * shape (its first turns, or just after a pivot), and a better name replaces the previous
   * one when the model judges the work changed. `settled`: the name has held, and is replaced only when the work changed.
   */
  stage: "forming" | "settled"
  /** In the forming stage, how many checks since it began, and how many in a row kept the name. */
  checks: number
  keeps: number
  /**
   * In the settled stage, whether the last check judged the work changed without that
   * being confirmed: a second such check in a row confirms the pivot.
   */
  candidate: boolean
  /** What the last check was made against (see `Marks`). */
  prompt: string | null
  summary: string | null
  checkedAt: number
  /**
   * What murmur wrote the terminal's title for: its digest as a plain shell or as an
   * agent's; null when it wrote none since the runner started. A shell's title starts the
   * agent that runs there forming, not settled.
   */
  titledFrom: "shell" | "agent" | null
  /** Whether a check of this root session was made, so the first one is made on its first mission. */
  started: boolean
  /**
   * The marks as they were before the oldest check whose job has not ended, and whether
   * any such check followed a hard signal: a job that is stopped (murmur became unusable)
   * gives them back, so the evidence it was to judge is owed, not lost.
   */
  unsettled: Marks | null
  unsettledHard: boolean
  /**
   * A turn end was looked at, and the same report's prompt may not have been tallied yet:
   * the report that follows looks again. It lapses when a turn begins, so a report that
   * handled its Stop before the end was seen (the harnesses' Stop asks) leaves nothing to
   * be taken at the next turn's prompt, in the middle of its work.
   */
  recheck: boolean
  /**
   * A check that followed a hard signal had its title refused: the signal is kept owed, to
   * be asked once more; refused again, it is let go. */
  refusedHard: boolean
  /**
   * Whether the watch still has the root session it was made with, which may come from
   * the store (a runner restart): only its title can be taken to be the agent's then. A
   * new root session ends it.
   */
  restored: boolean
  /**
   * Whether a check of the name waits for its quiet, so reports in the meantime don't ask
   * again. Apart from the terminal's job, which a shell's description may hold too.
   */
  waiting: boolean
  /**
   * The plan and branch as they were at the last check that ran (stored title or not), which
   * a hard signal is told by; a plan or branch a check could not read keeps the one before.
   * Null until a check has seen them. The busiest folder is not among them: it
   * moves with every task inside a project, and would pivot too readily.
   */
  baseline: Facts | null
  /** The root session the watch has seen, as `work.session`; null before any. */
  session: string | null
  /** The turn end (`lastTurn.at`) last looked at, so each end is looked at once. */
  turnSeen: number | null
  /** The one timer that makes the check owed when evidence came inside the settled gap. */
  gapTimer: NodeJS.Timeout | undefined
  /** A check is owed because it did not run (or a summary came while murmur was unusable). */
  owed: boolean
  /** Whether the owed check follows a hard signal (a summary). */
  owedHard: boolean
  /**
   * The root session the agent's summary was written in (as `work.session`); undefined when
   * unknown, as after a runner restart. A summary of an earlier session says nothing of
   * this one's mission.
   */
  summarySession: string | null | undefined
  /** Until when a check that could not be asked for waits to be asked again. */
  retryAt: number
  /** The timer that asks again then, for a terminal that sends no reports meanwhile. */
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
  /** The headlines asked for, by request (`headlineKey`), so each is asked for once. */
  headlines: Set<string>
  /** The turn end (`lastTurn.at`) whose gist was asked for, so it is asked for once. */
  gist: number | null
  /** The gist asked for did not run: it is asked for again after `retryMs`. */
  gistOwed: boolean
  /** The timer that asks for headlines and a gist that did not run again. */
  noteRetry: NodeJS.Timeout | undefined
}

const headlineKey = (terminalId: string, request: Request): string =>
  `${terminalId}\0headline\0${request.requestId}\0${request.askedAt}`

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

/**
 * Whether the plan or the branch moved from the baseline: both known and different. One
 * that was unknown and now is read is no change: entering plan mode for the same task, or
 * a branch read in time, is not a new subject.
 */
const shifted = (baseline: Facts | null, facts: Facts): boolean =>
  baseline !== null &&
  (["plan", "branch"] as const).some(
    (fact) => baseline[fact] !== null && facts[fact] !== null && baseline[fact] !== facts[fact],
  )

/**
 * The facts a check leaves as the baseline: what it read, but a plan or branch it could
 * not read keeps the one before, so a plan that flickers to none and back is no change.
 */
const rebased = (baseline: Facts | null, facts: Facts): Facts => ({
  ...facts,
  plan: facts.plan ?? baseline?.plan ?? null,
  branch: facts.branch ?? baseline?.branch ?? null,
})

/** The activity's turn end, as `lastTurn.at`, when it is idle after a turn that ended; else null. */
const turnEndOf = (activity: Activity): number | null => {
  const turn = activity.lastTurn
  if (activity.state !== "idle" || !turn) return null
  return turn.outcome === "completed" || turn.outcome === "failed" || turn.outcome === "interrupted"
    ? turn.at
    : null
}

// A summary as compared: lower case, spaces collapsed; null is none.
const words = (text: string | null): string =>
  (text ?? "").toLowerCase().replace(/\s+/g, " ").trim()

const programKey = (program: ForegroundProcess | null): string | null =>
  program === null ? null : JSON.stringify([program.name, program.argv])

/**
 * Decides when each terminal is described and what from, and hands the result to the
 * manager. Without a describer, nothing happens. A terminal the person titled is never
 * asked about; if they clear their title it is eligible again on the next evidence.
 *
 * An agent's terminal is in one of two stages, and is checked at its turns' ends.
 *
 * - Forming (a new root session, or just after a pivot): the first check is made
 *   `settleMs` after the person's first substantial prompt (its mission; not "hey!" nor
 *   "try again") or the agent's first summary. Then it is checked at every turn end that
 *   brought new evidence, with no rate limit, and a check replaces the name when the model
 *   judges the work changed (or there is none yet).
 *   Two checks in a row that kept the name, or four checks in all, settle it.
 * - Settled: it is checked at a turn end with new evidence, at most once in `settledGapMs`.
 *   Evidence that comes inside the gap sets one timer for when it ends, so a window that
 *   goes quiet right after a change is still checked. The model says whether the work
 *   differs from the previous title's: if not, the name is kept; if so, it is a pivot
 *   candidate, applied (back to forming) when the previous settled check said so too or a
 *   hard signal came with it, else the name is kept and the candidate remembered.
 *
 * New evidence is a substantial prompt not seen at the last check, a new summary, or a
 * change of the git branch or the plan's title since the last check. A turn whose
 * only prompt was "ok" or "go on" brings none. A hard signal (a new `summarize` summary,
 * a changed branch or plan) ignores the settled gap and renames directly (it is shown a forming digest). A turn
 * end is told by the activity going idle with a new `lastTurn.at`, which every harness's
 * events give alike. A compaction does nothing; a new root session returns to forming and
 * keeps the name until there is new evidence. An agent's own `open_terminal` title starts
 * the terminal settled, so murmur replaces it only on a pivot.
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
  // The headlines of questions and plans, and gists of replies (see `changed`, `replied`).
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
        this.descriptions.stop()
        this.notes.stop()
        // What waited is dropped, and what a stopped check was to judge is owed again.
        for (const watch of this.watches.values()) this.undo(watch)
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
      this.resetRetry(watch)
      this.resetNotes(watch)
      this.reform(watch)
      watch.titledFrom = null
      watch.baseline = null
      watch.shellOwed = false
      watch.screenKey = null
    }
    try {
      this.host.cleared()
    } catch (error) {
      console.error("Novadeck could not clear the terminals' murmur text:", error)
    }
  }

  // What was asked for and owed of headlines and gists is forgotten.
  private resetNotes(watch: Watch): void {
    clearTimeout(watch.noteRetry)
    watch.noteRetry = undefined
    watch.headlines.clear()
    watch.gist = null
    watch.gistOwed = false
  }

  // Headlines and a gist that did not run are asked for again after `retryMs`.
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

  // The agent terminal's name starts over: forming, with no check made in this session, and
  // nothing owed or waiting. The stored title and the baseline of the facts stay, if any.
  private reform(watch: Watch): void {
    clearTimeout(watch.gapTimer)
    watch.gapTimer = undefined
    this.resetRetry(watch)
    watch.stage = "forming"
    watch.checks = 0
    watch.keeps = 0
    watch.candidate = false
    watch.prompt = null
    watch.summary = null
    watch.checkedAt = 0
    watch.started = false
    watch.waiting = false
    watch.unsettled = null
    watch.unsettledHard = false
    watch.recheck = false
    watch.refusedHard = false
    watch.restored = false
    watch.owed = false
    watch.owedHard = false
  }

  // A job was stopped before it ran: what its check saw is unseen again, and owed.
  private undo(watch: Watch): void {
    watch.waiting = false
    if (watch.unsettled === null) return
    watch.prompt = watch.unsettled.prompt
    watch.summary = watch.unsettled.summary
    watch.checkedAt = watch.unsettled.at
    watch.started = watch.unsettled.started
    watch.owed = true
    watch.owedHard = watch.owedHard || watch.unsettledHard
    watch.unsettled = null
    watch.unsettledHard = false
  }

  private resetRetry(watch: Watch): void {
    clearTimeout(watch.retryTimer)
    watch.retryTimer = undefined
    watch.retryAt = 0
  }

  /** A terminal is gone or closed. */
  gone(terminalId: string): void {
    const watch = this.watches.get(terminalId)
    if (watch) {
      this.resetRetry(watch)
      this.resetNotes(watch)
      clearTimeout(watch.gapTimer)
    }
    this.descriptions.cancel(terminalId)
    this.notes.forget(terminalId)
    this.watches.delete(terminalId)
  }

  stop(): void {
    this.unwatch()
    this.unwatchCleared()
    for (const watch of this.watches.values()) {
      this.resetRetry(watch)
      this.resetNotes(watch)
      clearTimeout(watch.gapTimer)
    }
    this.descriptions.stop()
    this.notes.stop()
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
    // A corrected root session carries its summary, and the watch, over.
    for (const { from, to } of told.corrected ?? []) {
      if (watch.summarySession === from) watch.summarySession = to
      if (watch.session === from) watch.session = to
    }
    // A new root session starts the name over, whether murmur can write one now or not;
    // the name it has stays until the session brings evidence of its own. The first
    // session the watch sees is no change: an agent-titled terminal begins settled.
    const session = subject.work?.session ?? null
    if (told.session && session !== null && watch.session !== null && session !== watch.session)
      this.reform(watch)
    if (session !== null) watch.session = session
    // A title kept across a runner restart, whose source is lost, of an agent that already
    // worked in this session is the agent's: the terminal is settled, with what it has seen.
    const seen = latestPrompt(subject.work)
    if (
      watch.restored &&
      watch.titledFrom === null &&
      !watch.started &&
      subject.naming.murmur !== null &&
      seen !== null
    ) {
      watch.stage = "settled"
      watch.started = true
      watch.prompt = seen
      watch.titledFrom = "agent"
    }
    // The run in the shell's foreground is the agent's from here on, and its end owes the
    // shell nothing: the sampler sees the foreground change only when it does (the program
    // the agent runs as stays the same all along), so it is noted when the agent binds.
    watch.agentRan = true
    if (!this.usable || subject.naming.person !== null) return
    if (watch.recheck) {
      watch.recheck = false
      this.turnEnded(terminalId)
    }
    // A check waits for a prompt to say what the terminal is for (its mission) or for the
    // agent's first summary; one in the making is not asked for again at each report. A
    // terminal with no name at all is named from any new evidence, as soon as it comes;
    // one with a name is checked at its turn ends (see `consider`) and its summaries.
    // A check that could not run is owed, and asked for again once `retryMs` passed.
    if (watch.waiting || Date.now() < watch.retryAt) return
    if (this.missionOf(subject) === undefined) return
    if (
      !watch.started ||
      watch.owed ||
      (this.previousOf(subject, watch) === null && this.fresh(subject, watch))
    )
      this.check(terminalId, this.times.settleMs, watch.owedHard)
  }

  // The title the terminal has now, murmur's or else its opening agent's; null for none.
  // A title murmur wrote for the terminal as a plain shell is left out: it names what the
  // shell did, not the agent's work, and would only anchor the model to the wrong subject.
  // The agent is titled afresh, forming, and the shell's title shows until it is.
  private previousOf(subject: MurmurSubject, watch: Watch): Previous {
    // Nor is a title of unknown source (kept across a restart) once a new session began.
    const foreign = watch.titledFrom === "shell" || (watch.titledFrom === null && !watch.restored)
    const murmur = foreign ? undefined : subject.naming.murmur?.title
    const title = murmur ?? subject.naming.agent?.title
    return title === undefined ? null : { title }
  }

  // Whether the terminal's prompts or summary hold evidence the last check did not see.
  private fresh(subject: MurmurSubject, watch: Watch): boolean {
    const prompt = latestPrompt(subject.work)
    const summary = this.currentSummary(subject)
    return (
      (prompt !== null && prompt !== watch.prompt) ||
      (summary !== null && words(summary) !== words(watch.summary))
    )
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
   * murmur has to title it by, and a hard signal: it is checked right away, a pivot it
   * shows is applied at once, and it locks nothing.
   */
  summarized(terminalId: string): void {
    const subject = this.host.subject(terminalId)
    if (!subject?.agent) return
    const watch = this.watch(terminalId)
    // Where the summary was written counts whether murmur can use it now or not.
    watch.summarySession = subject.work?.session ?? null
    if (subject.naming.person !== null) return
    // A summary murmur could not use is owed a check once it can.
    // Only a summary that says something other than the last one seen is a hard signal: the
    // same again, as the agent's nudges (drift, every 15 prompts) bring it, is evidence like
    // any other.
    const fresh = this.freshSummary(subject, watch)
    if (!this.usable) {
      watch.owed = true
      watch.owedHard ||= fresh
      return
    }
    if (fresh) this.check(terminalId, this.times.settleMs, true)
    else this.turnEnded(terminalId)
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
    watch.waiting = false
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
   * The terminal's agent activity changed: question and plan requests with no headline get
   * one; jobs for requests that no longer wait, or for a turn end that is no longer the
   * last, are called off.
   */
  changed(terminalId: string): void {
    try {
      this.look(terminalId)
    } catch (error) {
      console.error("Novadeck could not look at a terminal to write its notes:", error)
    }
  }

  private look(terminalId: string): void {
    const subject = this.host.subject(terminalId)
    const watch = this.watches.get(terminalId)
    const activity = subject?.agent ? subject.activity : null
    if (!activity) {
      if (watch) this.forgetNotes(terminalId, watch)
      return
    }
    // A turn that ended brings a look at the terminal's name, once.
    const ended = turnEndOf(activity)
    if (watch && ended !== null && ended !== watch.turnSeen) {
      watch.turnSeen = ended
      // The report that brought this end may tally its prompt after this look: the report
      // handled next looks again, if the terminal is still idle (see `recheck`).
      watch.recheck = true
      this.turnEnded(terminalId)
    } else if (watch && ended === null) {
      // A turn began or goes on: what was left to look at again belonged to the end before.
      watch.recheck = false
    }
    const asked = activity.pending.filter((request) => request.kind !== "permission")
    if (!watch && asked.length === 0) return
    const mine = this.watch(terminalId)
    const keys = new Set(asked.map((request) => headlineKey(terminalId, request)))
    for (const key of mine.headlines)
      if (!keys.has(key)) {
        this.notes.cancel(key)
        mine.headlines.delete(key)
      }
    if (mine.gist !== null && !endedAt(activity, mine.gist)) {
      this.notes.cancel(gistKey(terminalId))
      mine.gist = null
      mine.gistOwed = false
    }
    if (!this.usable) return
    for (const request of asked) {
      const key = headlineKey(terminalId, request)
      if (request.headline !== undefined || mine.headlines.has(key)) continue
      mine.headlines.add(key)
      // Nothing to show of the request is final for it: it is not asked for at each change.
      let final = false
      this.notes.request(
        key,
        this.times.noteMs,
        async () => {
          const digest = await this.headlineDigestOf(terminalId, request)
          final = digest === null
          return digest ?? undefined
        },
        (outcome, digest) => {
          if (outcome === undefined) {
            if (final) return
            mine.headlines.delete(key)
            // The describer did not run: it is asked again in a while.
            if (digest) this.retryNotes(terminalId, mine)
          } else if (outcome?.kind === "headline")
            this.host.headlined(terminalId, request, outcome.text)
        },
        terminalId,
      )
    }
  }

  private forgetNotes(terminalId: string, watch: Watch): void {
    this.notes.forget(terminalId)
    this.resetNotes(watch)
  }

  // What the request is shown by, read as the job runs: undefined once it no longer waits
  // or while its plan is unknown, null when there is nothing to show of it (a question with
  // no subject, a plan that can't be read), which stays so until the request changes.
  private async headlineDigestOf(
    terminalId: string,
    asked: Request,
  ): Promise<NoteDigest | null | undefined> {
    if (!this.usable) return undefined
    const activity = this.host.subject(terminalId)?.activity
    const request = activity?.pending.find(
      ({ requestId, askedAt }) => requestId === asked.requestId && askedAt === asked.askedAt,
    )
    if (!activity || !request || request.headline !== undefined) return undefined
    if (request.kind === "question") return questionDigest(request)
    const source = activity.plans.find(({ actor }) => actor === request.actor)?.source
    if (!source) return undefined
    const text = source.kind === "text" ? source.text : await this.host.fileHead(source.path)
    // Read again after waiting: the request may have been answered or revised.
    const still = this.host
      .subject(terminalId)
      ?.activity?.pending.some(
        ({ requestId, askedAt }) => requestId === asked.requestId && askedAt === asked.askedAt,
      )
    if (!still) return undefined
    return text === null ? null : planDigest(text)
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
          } else if (outcome?.kind === "gist")
            this.host.gisted(terminalId, at, { text: outcome.text, asks: outcome.asks })
        },
        terminalId,
      )
    } catch (error) {
      console.error("Novadeck could not look at a terminal to write its gist:", error)
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
      // A terminal that has a title already begins settled, having seen the prompts it
      // has: only evidence after this replaces it. That is the one its opening agent gave,
      // or murmur's, kept across a restart, of a terminal with an agent bound: where it
      // came from is lost, and a bound agent most likely wrote it. A plain shell's, or one
      // whose title may be a shell's, begins forming.
      const subject = this.host.subject(terminalId)
      const titled =
        subject !== undefined &&
        (subject.naming.agent !== null ||
          (subject.naming.murmur !== null && subject.agent !== null))
      watch = {
        stage: titled ? "settled" : "forming",
        checks: 0,
        keeps: 0,
        candidate: false,
        prompt: titled && subject ? latestPrompt(subject.work) : null,
        summary: null,
        checkedAt: 0,
        started: titled,
        titledFrom: titled ? "agent" : null,
        waiting: false,
        unsettled: null,
        unsettledHard: false,
        recheck: false,
        refusedHard: false,
        restored: subject?.work != null,
        baseline: null,
        session: subject?.work?.session ?? null,
        turnSeen: (subject?.activity && turnEndOf(subject.activity)) ?? null,
        gapTimer: undefined,
        owed: false,
        owedHard: false,
        summarySession: undefined,
        retryAt: 0,
        retryTimer: undefined,
        program: { key: null, since: Date.now() },
        agentRan: false,
        shellOwed: false,
        screenKey: null,
        since: Date.now(),
        headlines: new Set(),
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
      console.error("Novadeck could not list the terminals to describe:", error)
    }
    // One terminal that cannot be looked at leaves the others their turn.
    for (const subject of subjects) {
      try {
        this.catchUpOne(subject)
        this.catchUpNotes(subject.summary.id)
      } catch (error) {
        console.error("Novadeck could not look at a terminal to describe it:", error)
      }
    }
  }

  // Questions and plans without a headline, and a reply without a gist, are asked for again.
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
      // Whether a check is due is for `react` to tell: the first of a session, one that did
      // not run, or a terminal that has no name yet.
      this.react(id, { session: false })
      return
    }
    if (subject.naming.murmur !== null) return
    watch.shellOwed = true
    this.ask(id, this.times.shellSettleMs)
  }

  /**
   * A turn of the agent ended: if it brought new evidence, the name is checked, at once in
   * the forming stage; in the settled stage at once if the gap since the last check has
   * passed or a hard signal came, else when the gap ends.
   */
  private turnEnded(terminalId: string): void {
    this.consider(terminalId).catch((error: unknown) =>
      console.error("Novadeck could not look at a terminal to describe it:", error),
    )
  }

  private async consider(terminalId: string): Promise<void> {
    const watch = this.watches.get(terminalId)
    const subject = this.host.subject(terminalId)
    if (!watch || !this.usable || !subject?.agent || subject.naming.person !== null) return
    // A check that could not run is asked for again by its own timer.
    if (Date.now() < watch.retryAt) return
    const facts = await this.host.facts(subject)
    // Read again after waiting: the terminal may have moved on or gone.
    const now = this.host.subject(terminalId)
    if (this.watches.get(terminalId) !== watch || !this.usable) return
    if (!now?.agent || now.naming.person !== null) return
    const hard = shifted(watch.baseline, facts) || this.freshSummary(now, watch)
    if (!hard && !this.fresh(now, watch)) return
    if (watch.stage === "forming") {
      this.check(terminalId, this.times.settleMs, false)
      return
    }
    const wait = watch.checkedAt + this.times.settledGapMs - Date.now()
    if (hard || wait <= 0) this.check(terminalId, this.times.settleMs, hard)
    else this.owe(terminalId, watch, wait)
  }

  // Whether the agent's current summary is one the last check did not see.
  private freshSummary(subject: MurmurSubject, watch: Watch): boolean {
    const summary = this.currentSummary(subject)
    return summary !== null && words(summary) !== words(watch.summary)
  }

  // Evidence came inside the settled gap: one timer checks when it ends, however much more
  // evidence comes meanwhile.
  private owe(terminalId: string, watch: Watch, waitMs: number): void {
    if (watch.gapTimer !== undefined) return
    watch.gapTimer = setTimeout(() => {
      watch.gapTimer = undefined
      this.turnEnded(terminalId)
    }, waitMs)
    watch.gapTimer.unref()
  }

  /**
   * Checks the agent terminal's name after `delayMs`: a digest of it is built then, so a
   * burst makes one check, and a later one replaces it. `hard` says a hard signal came
   * with it (a summary); the digest's facts may add one (a changed branch or plan).
   */
  private check(terminalId: string, delayMs: number, hard: boolean): void {
    const watch = this.watch(terminalId)
    clearTimeout(watch.gapTimer)
    watch.gapTimer = undefined
    // What the build saw, for the outcome to judge and, if the job did not run, to undo.
    let ran: { hard: boolean; facts: Facts; previous: string | null; before: Marks } | null = null
    watch.waiting = true
    this.descriptions.request(
      terminalId,
      delayMs,
      async () => {
        ran = null
        watch.waiting = false
        // Nothing is built, read or serialized while murmur isn't usable.
        if (!this.usable) return undefined
        const current = this.host.subject(terminalId)
        if (!current?.agent || current.naming.person !== null) return undefined
        const built = await this.agentDigestOf(current, watch, hard)
        if (!built) return undefined
        // What the digest was built from is what this check saw, and the gap runs from now.
        ran = {
          hard: built.hard,
          facts: built.facts,
          previous: built.digest.previous?.title ?? null,
          before: {
            prompt: watch.prompt,
            summary: watch.summary,
            at: watch.checkedAt,
            started: watch.started,
          },
        }
        if (watch.unsettled === null) watch.unsettled = ran.before
        watch.unsettledHard ||= ran.hard
        watch.prompt = latestPrompt(built.subject.work)
        watch.summary = this.currentSummary(built.subject)
        watch.checkedAt = Date.now()
        watch.started = true
        watch.owed = false
        watch.owedHard = false
        return built.digest
      },
      (outcome) => this.checked(terminalId, watch, outcome, ran),
    )
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
    // A shell's request takes the terminal's one job from any agent check waiting for it.
    // An agent check still waiting for its quiet is replaced by this request, and has
    // marked nothing. One running is aborted only when this job starts (see below).
    const mine = this.watches.get(terminalId)
    if (mine) mine.waiting = false
    // A shell opened to run an agent waits for it to bind, or for the wait to pass.
    const subject = this.host.subject(terminalId)
    const wait = subject && !subject.agent ? this.expectedFor(subject) : 0
    let key: string | null = null
    this.descriptions.request(
      terminalId,
      Math.max(delayMs, wait),
      async () => {
        key = null
        // The job starts, and aborts an agent check still running: it gives back the
        // evidence it was to judge. (One that ended before this is settled already.)
        if (mine) this.undo(mine)
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

  // The digest an agent's terminal is described from, the facts it is built on, and the
  // terminal as it was read after waiting.
  // A check that carries a hard signal (given, or told by the facts and the summary as they
  // are now) is shown as a forming one: the model is asked to name the work afresh, not to
  // keep a name unless the latest prompt overturns it, since the signal already says the
  // work moved.
  private async agentDigestOf(
    subject: MurmurSubject,
    watch: Watch,
    given: boolean,
  ): Promise<
    { digest: AgentDigest; facts: Facts; subject: MurmurSubject; hard: boolean } | undefined
  > {
    const id = subject.summary.id
    const agent = subject.agent!
    const [facts, reply] = await Promise.all([this.host.facts(subject), this.replyOf(subject)])
    // Read again after waiting: the terminal may have moved on or gone.
    const now = this.host.subject(id)
    if (!now?.agent || now.naming.person !== null) return undefined
    const hard = given || shifted(watch.baseline, facts) || this.freshSummary(now, watch)
    const digest = agentDigest({
      harness: agent,
      projectFolder: this.host.projectFolder(now.summary.sessionId),
      cwd: now.summary.cwd,
      branch: facts.branch,
      plan: facts.plan,
      work: now.work,
      reply,
      summary: this.currentSummary(now),
      previous: this.previousOf(now, watch),
      stage: hard ? "forming" : watch.stage,
    })
    return digest ? { digest, facts, subject: now, hard } : undefined
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
      cwd: now.summary.cwd,
      command,
      rows: screen.rows,
      alternate,
      ...(screen.commandRow !== undefined && { commandRow: screen.commandRow }),
      ...(screen.wrapped && { wrapped: screen.wrapped }),
      ...(screen.continues && { rowContinues: screen.continues }),
      // A title an agent's check wrote names its work, not what the shell does now.
      previous: watch.titledFrom === "agent" ? null : now.naming.murmur,
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
    if (!outcome) return
    this.store(terminalId, outcome.title)
    // An agent that starts in this shell, or after the one that left it, is a new subject:
    // its name forms from its own work, whatever stage the last agent's had reached.
    const watch = this.watches.get(terminalId)
    if (!watch) return
    this.reform(watch)
    watch.titledFrom = "shell"
  }

  /**
   * An agent terminal's check ended. A refusal (null) closes it; murmur not running
   * (undefined) undoes it, leaving the evidence owed, to be asked for again after
   * `retryMs`; a title is judged by the stage the terminal is in.
   */
  private checked(
    terminalId: string,
    watch: Watch,
    outcome: Description | null | undefined,
    ran: { hard: boolean; facts: Facts; previous: string | null; before: Marks } | null,
  ): void {
    if (this.watches.get(terminalId) !== watch) return
    const before = watch.unsettled
    const hardBefore = watch.unsettledHard
    watch.unsettled = null
    watch.unsettledHard = false
    if (outcome === undefined) {
      this.unrun(terminalId, watch, ran, before, hardBefore)
      return
    }
    this.resetRetry(watch)
    if (ran === null) return
    // Every check that ran has seen the facts as they are: a change of the branch or plan
    // is a hard signal once, not at every turn end after a verdict that kept the name.
    // A refusal of a hard signal's check keeps the signal, once: the summary is unseen and
    // the baseline stays, so the next check is hard again and names the work afresh.
    if (outcome === null && ran.hard && !watch.refusedHard) {
      watch.refusedHard = true
      if (before) watch.summary = before.summary
      return
    }
    watch.refusedHard = false
    watch.baseline = rebased(watch.baseline, ran.facts)
    if (outcome === null) return
    const title = outcome.title.trim()
    if (!terminalTitle.safeParse(title).success) return
    // The person may have titled the terminal while the model ran.
    if (this.host.subject(terminalId)?.naming.person !== null) return
    const same = title === ran.previous
    const kept = !outcome.changed || same
    if (watch.stage === "forming") {
      // Forming, the name follows the work; it settles once it has held twice in a
      // row, or after four checks whatever they said.
      // A better name replaces the previous one only when the model judges the work changed
      // (or there is none yet); a verdict that it did not is a keep.
      if (!same && this.renames(outcome, title, ran))
        this.store(terminalId, title, ran.facts, watch)
      watch.checks += 1
      watch.keeps = kept ? watch.keeps + 1 : 0
      if (watch.keeps >= keepsToSettle || watch.checks >= formingChecks) {
        watch.stage = "settled"
        watch.candidate = false
      }
      return
    }
    // A hard signal renames directly, as in forming, with no verdict needed (it was shown a
    // forming digest): a title that differs is a new phase, and forms again.
    if (ran.hard) {
      watch.candidate = false
      if (same || !this.renames(outcome, title, ran)) return
      this.store(terminalId, title, ran.facts, watch)
      watch.stage = "forming"
      watch.checks = 0
      watch.keeps = 0
      return
    }
    if (kept) {
      watch.candidate = false
      return
    }
    // The work changed: it is a pivot once a second check in a row says so. Until then the
    // name is kept and the pivot remembered.
    if (!watch.candidate) {
      watch.candidate = true
      return
    }
    this.store(terminalId, title, ran.facts, watch)
    watch.stage = "forming"
    watch.checks = 0
    watch.keeps = 0
    watch.candidate = false
  }

  // Whether a differing title replaces the name: when the model judges the work changed,
  // when there is no name yet, or, after a hard signal (a summary, a new branch or plan),
  // when the new name shares no content word with the old one; a rewording of the same
  // work keeps the name.
  private renames(
    outcome: Description,
    title: string,
    ran: { readonly hard: boolean; readonly previous: string | null },
  ): boolean {
    if (outcome.changed || ran.previous === null) return true
    return ran.hard && !sharesContentWord(title, ran.previous)
  }

  // The check did not run: what it saw is unseen again, and it is owed once `retryMs` pass.
  private unrun(
    terminalId: string,
    watch: Watch,
    ran: { hard: boolean; facts: Facts; previous: string | null; before: Marks } | null,
    before: Marks | null,
    hard: boolean,
  ): void {
    if (ran === null || before === null) return
    const subject = this.host.subject(terminalId)
    if (!subject || subject.naming.person !== null) return
    watch.prompt = before.prompt
    watch.summary = before.summary
    watch.checkedAt = before.at
    watch.started = before.started
    watch.owed = true
    watch.owedHard = hard
    watch.retryAt = Date.now() + this.times.retryMs
    // An idle terminal sends no reports to ask again at: a timer does, once.
    clearTimeout(watch.retryTimer)
    watch.retryTimer = setTimeout(() => {
      watch.retryTimer = undefined
      this.reported(terminalId, { session: false })
    }, this.times.retryMs)
    watch.retryTimer.unref()
  }

  // A title came back: it names the terminal if it can be one. An agent terminal's also
  // takes the facts as they were then for the baseline of the next change.
  private store(terminalId: string, title: string, facts?: Facts, watch?: Watch): void {
    const mine = watch ?? this.watches.get(terminalId)
    if (mine) {
      this.resetRetry(mine)
      if (facts) mine.baseline = rebased(mine.baseline, facts)
    }
    const text = title.trim()
    if (!terminalTitle.safeParse(text).success) return
    if (this.host.subject(terminalId)?.naming.person) return
    this.host.described(terminalId, { title: text })
    if (mine && watch) mine.titledFrom = "agent"
  }
}

/** The preview of the agent's last reply, when its turn is over. */
const finishedReply = (activity: Activity | null): string | null =>
  activity && activity.state !== "working" ? (activity.lastTurn?.reply ?? null) : null

/** Whether the activity's last turn ended at `at`, completed or failed, with none running and no gist yet. */
const endedAt = (activity: Activity, at: number): boolean =>
  activity.state !== "working" &&
  activity.lastTurn?.at === at &&
  (activity.lastTurn.outcome === "completed" || activity.lastTurn.outcome === "failed") &&
  activity.lastTurn.gist === undefined
