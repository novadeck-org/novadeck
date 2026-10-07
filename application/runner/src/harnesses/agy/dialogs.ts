import type { RequestAnswer } from "@novadeck/protocol"

import type {
  DialogAdapter,
  DialogRead,
  KeyStep,
  ReadDialog,
  RequestFacts,
  ScreenRequest,
} from "../dialogs.js"

/**
 * Antigravity's dialogs, as its TUI draws them and takes keys (probed 2026-10-06, 1.2.14;
 * fixtures/ask.probe.json):
 *
 * - A command's confirmation, "Run this command?", and a file write's, "Allow creation of
 *   this file?": numbered options, one marked with `>`, which a digit takes at once, with
 *   no Enter. The options are read from the screen, never assumed: they differ by tool.
 *   The request's call (its PreToolUse, which decode keeps for the confirmation) must
 *   agree with what the screen shows: the command, or the file.
 * - ask_question: `Question i/n: <question>`, its options, then `Write-in...`. Down and
 *   Enter pick one (a digit selects at once too, but it is Down and Enter that were probed
 *   through every question of several); in a multi-select a digit toggles and Enter
 *   submits; Write-in is Down to its row, Enter, then `Your answer:` takes text and Enter.
 * - A plan asking for review is no modal: its screen is the prompt with a footer saying
 *   "/artifact to review". The request comes from `screenRequest`, as no hook says it
 *   (the status line says `reviewing`, which only a request of the screen can show
 *   without moving the activity), and `/artifact` + Enter lists it, where y or n answers.
 *
 * Anything else, or any of these not read in full, is unrecognised.
 */

const collapse = (text: string): string => text.replaceAll(/\s+/g, "")

// A command's rows as one line: each row trimmed, a row break read as one space, every
// other whitespace as it is, so `> x` is not `>x` nor `a  b` `a b` within a row.
const lined = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row !== "")
    .join(" ")

const rule = (row: string): boolean => /^─+$/.test(row.trim())

// A key that moves the highlight down.
const down = "\x1b[B"

// How long each wait for the screen to follow a key lasts.
const settle = 3000

type Option = {
  readonly number: number
  readonly label: string
  readonly marked: boolean
  readonly checked: boolean | undefined
}

// Numbered option rows from `from`: each `> 1. label` or `  2. label` (a multi-select's
// with its `[ ]` or `[x]`), the label's wrapped rest on rows of their own, until a blank
// row. They must run from 1 without a gap, and exactly one is marked.
const optionsFrom = (rows: readonly string[], from: number): Option[] | undefined => {
  const options: {
    number: number
    label: string
    marked: boolean
    checked: boolean | undefined
  }[] = []
  for (let index = from; index < rows.length; index += 1) {
    const row = rows[index]!.trimEnd()
    if (row.trim() === "") break
    const match = /^([> ]) (\d+)\. (?:\[( |x)\] )?(\S.*)$/.exec(row)
    if (match) {
      options.push({
        number: Number(match[2]),
        label: match[4]!.trim(),
        marked: match[1] === ">",
        checked: match[3] === undefined ? undefined : match[3] === "x",
      })
    } else {
      const last = options.at(-1)
      if (!last || rule(row)) return undefined
      last.label = `${last.label} ${row.trim()}`
    }
  }
  const sequential = options.every(({ number }, index) => number === index + 1)
  return options.length >= 2 && sequential && options.filter(({ marked }) => marked).length === 1
    ? options
    : undefined
}

// The footer after the options, which end at a blank row: its keys.
const footerAfter = (rows: readonly string[], from: number): string | undefined => {
  let index = from
  while (index < rows.length && rows[index]!.trim() !== "") index += 1
  const footer = rows[index + 1]?.trim()
  return footer?.startsWith("↑/↓ Navigate") ? footer : undefined
}

const only = <T>(found: readonly T[]): T | undefined => (found.length === 1 ? found[0] : undefined)

const rowsLike = (rows: readonly string[], pattern: RegExp): number[] =>
  rows.flatMap((row, index) => (pattern.test(row.trim()) ? [index] : []))

// The call a request's input holds: `{name, args}`, as its PreToolUse gave it.
const callOf = (input: unknown): { name: string; args: Record<string, unknown> } | undefined => {
  if (typeof input !== "object" || input === null) return undefined
  const { name, args } = input as { name?: unknown; args?: unknown }
  if (typeof name !== "string" || typeof args !== "object" || args === null) return undefined
  return { name, args: args as Record<string, unknown> }
}

// ---- Confirmations

type Confirmation = {
  readonly question: string
  readonly options: readonly Option[]
  /** What it shows of the call: a command's text, or what stands above the question. */
  readonly shown: string
  readonly command: boolean
  /** A command's tool lines above its heading. */
  readonly history?: string
  /** The tool a file confirmation's header names. */
  readonly tool?: string
}

// A command's confirmation, or a file's, read in full: from `Requesting permission for:`
// (the command it shows) or from above the question, to its footer.
const confirmation = (rows: readonly string[]): Confirmation | undefined => {
  const lines = rows.map((row) => row.trimEnd())
  const ask = only(rowsLike(lines, /^(Run this command\?|Allow [^?]+\?)$/))
  if (ask === undefined) return undefined
  const options = optionsFrom(lines, ask + 1)
  if (!options || footerAfter(lines, ask + 1) === undefined) return undefined
  const question = lines[ask]!.trim()
  if (question === "Run this command?") {
    const start = lines.findLastIndex(
      (row, index) => index < ask && row.trim() === "Requesting permission for:",
    )
    if (start < 0) return undefined
    const shown = lines
      .slice(start + 1, ask)
      .map((row) => row.trim())
      .join("\n")
      .trim()
    // The tool lines above its heading, which move on as calls run: all that tells one
    // of two identical queued commands from the next (empty where the heading scrolled off).
    const heading = lines.findLastIndex((row, index) => index < start && row.trim() === "Command")
    const history =
      heading < 0
        ? ""
        : lines
            .slice(Math.max(0, heading - 6), heading)
            .filter((row) => row.startsWith("● ") || row.startsWith("○ "))
            .join("\n")
    return shown === "" ? undefined : { question, options, shown, command: true, history }
  }
  // A file's: its header over a rule, then what it shows, down to the question.
  const ruleAt = lines.findLastIndex((row, index) => index < ask && rule(row))
  const header = ruleAt > 0 ? lines[ruleAt - 1]!.trim() : ""
  const tool = files[header]
  if (tool === undefined) return undefined
  const shown = lines
    .slice(ruleAt + 1, ask)
    .join("\n")
    .trim()
  return shown === "" ? undefined : { question, options, shown, command: false, tool }
}

// The tool each file confirmation's header means (only what was probed).
const files: { readonly [header: string]: string } = { "Create file": "write_to_file" }

// Whether what the screen shows of a command is the call's, all of it. A command cut short
// with `...` is no match, as its start could be another call's (parallel calls share one
// remembered call) and no cut-off screen has been probed: it reads raw.
const sameCommand = (shown: string, command: unknown): boolean =>
  typeof command === "string" && command.trim() !== "" && lined(shown) === lined(command)

// Whether the screen's confirmation is about the call the request names.
const matches = (read: Confirmation, input: unknown): boolean => {
  const call = callOf(input)
  if (!call) return false
  if (read.command)
    return call.name === "run_command" && sameCommand(read.shown, call.args.CommandLine)
  // A file's: the header names the call's tool, and the dialog's own first line, between
  // that header and the question, starts with the call's whole path.
  const file = call.args.TargetFile
  if (typeof file !== "string" || file.trim() === "" || call.name !== read.tool) return false
  const line = read.shown.split("\n")[0]!.replace(/\s+[+-]\d+(\s+[+-]\d+)*\s*$/, "")
  return collapse(line) === collapse(file)
}

const digit = (number: number): string | undefined => (number <= 9 ? String(number) : undefined)

// Commands run, and commands still waiting, as the tool lines above a command's dialog
// tell: 1.2.14 marks a queued call `○` until it is its turn; 1.3.0 folds the ones that ran
// into `● Ran N commands`.
const progress = (history: string): { ran: number; waiting: number } => {
  const rows = history.split("\n")
  const ran = rows.reduce((total, row) => {
    const folded = /^● Ran (\d+) commands? /.exec(row)
    return total + (folded ? Number(folded[1]) : row.startsWith("● Ran (") ? 1 : 0)
  }, 0)
  return { ran, waiting: rows.filter((row) => row.startsWith("○ ")).length }
}

// Whether the tool lines moved on as an answered command's would: more ran, or fewer wait.
// Any other change of them (a redraw, a hint toggled) is nothing.
const progressed = (before: string | undefined, now: string | undefined): boolean => {
  if (!before || !now) return false
  const was = progress(before)
  const is = progress(now)
  return is.ran > was.ran || is.waiting < was.waiting
}

const confirmationRead = (
  rows: readonly string[],
  request: RequestFacts,
): DialogRead | undefined => {
  const read = confirmation(rows)
  if (!read || !matches(read, request.input)) return undefined
  const keyed = read.options.map(({ number }) => digit(number))
  if (keyed.includes(undefined)) return undefined
  const dialog: ReadDialog = {
    type: "choices",
    title: read.question,
    detail: read.shown,
    // Its No refuses and ends the turn (probed), so the person's words may follow it as
    // the next prompt, which the driver sends once the dialog is answered.
    options: read.options.map(({ number, label }) => ({
      id: String(number),
      label,
      text: /^No\b/.test(label) ? ("prompt" as const) : null,
    })),
  }
  return {
    dialog,
    // A digit acts at once. Its Amend (tab) approves with words, which isn't offered. Words
    // go with the No only, as the prompt after it.
    keys: (answer) => {
      if (answer.type !== "choice") return undefined
      const chosen = read.options.find(({ number }) => String(number) === answer.option)
      if (!chosen || (answer.text !== undefined && !/^No\b/.test(chosen.label))) return undefined
      return [{ press: answer.option }]
    },
    answered: (later) => {
      if (!later.some((row) => row.trim() === read.question)) return true
      // Still up, or another call's, as parallel calls show theirs one at a time.
      const next = confirmation(later)
      if (next === undefined) return false
      if (next.shown !== read.shown || next.question !== read.question) return true
      // Identical queued commands: the first is answered once the tool lines moved on.
      return progressed(read.history, next.history)
    },
  }
}

// ---- ask_question

type Asked = {
  readonly index: number
  readonly total: number
  readonly question: string
  readonly options: readonly Option[]
  readonly multi: boolean
  /** Whether its Write-in field is open. */
  readonly writing: boolean
}

// The question on screen, read in full: `Question i/n: <question>` (its wrapped rest on
// the rows after), its options, and the keys' footer, or its open write-in field.
const asked = (rows: readonly string[]): Asked | undefined => {
  const lines = rows.map((row) => row.trimEnd())
  const at = only(rowsLike(lines, /^Question \d+\/\d+: .+$/))
  if (at === undefined) return undefined
  const match = /^Question (\d+)\/(\d+): (.+)$/.exec(lines[at]!.trim())!
  let end = at + 1
  const words = [match[3]!]
  while (end < lines.length && lines[end]!.trim() !== "") words.push(lines[end++]!.trim())
  const options = optionsFrom(lines, end + 1)
  if (!options) return undefined
  // Its list's keys, or, with the write-in open, its field and the keys that follow it.
  let after = end + 1
  while (after < lines.length && lines[after]!.trim() !== "") after += 1
  const field = lines
    .slice(after + 1)
    .find((row) => row.trim() !== "")
    ?.trim()
  const writing =
    field?.startsWith("Your answer:") === true &&
    lines.some((row) => row.trim().startsWith("enter Submit · esc Back"))
  const footer = writing ? "" : footerAfter(lines, end + 1)
  if (footer === undefined) return undefined
  const index = Number(match[1])
  const total = Number(match[2])
  if (index < 1 || index > total) return undefined
  // A multi-select's rows all carry a check box, but its Write-in's; a single's none.
  const boxes = options.filter(({ checked }) => checked !== undefined).length
  const multi = writing ? boxes > 0 : footer.includes("space Toggle")
  if (boxes !== (multi ? options.length - 1 : 0)) return undefined
  return { index, total, question: words.join(" "), options, multi, writing }
}

type Question = { question: string; options: string[]; multi: boolean }

// The questions of an ask_question call, each whole, or none.
const questionsOf = (input: unknown): Question[] | undefined => {
  const call = callOf(input)
  if (call?.name !== "ask_question" || !Array.isArray(call.args.questions)) return undefined
  const questions: Question[] = []
  for (const each of call.args.questions as unknown[]) {
    const { question, options, is_multi_select: multi } = (each ?? {}) as Record<string, unknown>
    if (typeof question !== "string" || question.trim() === "") return undefined
    if (!Array.isArray(options) || !options.every((option) => typeof option === "string"))
      return undefined
    if (multi !== undefined && typeof multi !== "boolean") return undefined
    questions.push({ question, options: options as string[], multi: multi === true })
  }
  // The most its dialog's schema holds, and as many options as a digit names.
  return questions.length >= 1 &&
    questions.length <= 8 &&
    questions.every(({ options }) => options.length >= 1 && options.length <= 8)
    ? questions
    : undefined
}

const writeIn = "Write-in..."

const highlighted = (rows: readonly string[], index: number, number: number): boolean => {
  const now = asked(rows)
  return now?.index === index && now.options.find(({ marked }) => marked)?.number === number
}

// Down to option `number` from the first, and a wait for the highlight to be there.
const moveTo = (index: number, number: number): KeyStep[] =>
  number === 1
    ? []
    : [
        ...Array.from({ length: number - 1 }, () => ({ press: down })),
        {
          until: (rows) => highlighted(rows, index, number),
          timeoutMs: settle,
          why: `option ${number} of question ${index} highlighted`,
        },
      ]

// Words typed into a one-line field: no line breaks or other control characters.
// eslint-disable-next-line no-control-regex -- These are the characters it refuses.
const plain = (text: string): boolean => /^[^\x00-\x1f\x7f]+$/.test(text)

// How much of typed words must show where they were typed.
const shownStart = 24

// A wait until `text`'s start shows in the row `where` finds: a row of the field it was
// typed into, never any other that happens to hold the same few letters.
const shows = (
  text: string,
  where: (rows: readonly string[]) => string | undefined,
  why: string,
): KeyStep => {
  const start = collapse(text).slice(0, shownStart)
  return {
    until: (rows) => start !== "" && collapse(where(rows) ?? "").startsWith(start),
    timeoutMs: settle,
    why,
  }
}

// The row after `Your answer:`, where a write-in's words appear.
const fieldRow = (rows: readonly string[]): string | undefined => {
  const at = rows.findLastIndex((row) => row.trim() === "Your answer:")
  return at < 0 ? undefined : rows.slice(at + 1).find((row) => row.trim() !== "")
}

const questionsRead = (rows: readonly string[], request: RequestFacts): DialogRead | undefined => {
  const read = asked(rows)
  const questions = questionsOf(request.input)
  if (!read || !questions || read.total !== questions.length) return undefined
  // Any state of the dialog reads as the same one, as the driver reads it again before
  // each key; only where it stands at its start do answers have keys.
  const shown = questions[read.index - 1]!
  if (questions.length > 1 && questions.some(({ multi }) => multi)) return undefined
  if (read.multi !== shown.multi || collapse(read.question) !== collapse(shown.question))
    return undefined
  const labels = [...shown.options, writeIn].map(collapse)
  if (read.options.length !== labels.length) return undefined
  if (!read.options.every(({ label }, index) => collapse(label) === labels[index])) return undefined
  const [first] = questions
  const start =
    read.index === 1 &&
    !read.writing &&
    read.options[0]!.marked &&
    !read.options.some(({ checked }) => checked === true)
  if (!first) return undefined
  const text = questions.length === 1 && !first.multi
  const dialog: ReadDialog = {
    type: "questions",
    questions: questions.map(({ question, options, multi }, index) => ({
      id: String(index + 1),
      header: null,
      question,
      options: options.map((label, at) => ({ id: String(at + 1), label, description: null })),
      multiSelect: multi,
      text,
    })),
    // Set aside to talk over: the words as its answer, through Write-in.
    chat: text ? ("field" as const) : null,
  }
  return {
    dialog,
    keys: (answer) => {
      if (!start) return undefined
      if (answer.type !== "chat") return keysFor(answer, questions)
      // The words, said to open the talk, as the answer the agent reads.
      const words = answer.text === undefined ? undefined : `${chatPrefix}${answer.text}`
      return text && words !== undefined && plain(answer.text!) && collapse(answer.text!) !== ""
        ? writeInSteps(1, questions[0]!.options.length, words)
        : undefined
    },
    answered: (later) => {
      // Its write-in field is still it; any other question of the call, or a later one
      // with the same words, is the same dialog, and any other is none of this.
      if (later.some((row) => row.trim() === "Your answer:")) return false
      const now = asked(later)
      if (now)
        return !questions.some(({ question }) => collapse(question) === collapse(now.question))
      return !later.some((row) => /^Question \d+\/\d+: /.test(row.trim()))
    },
  }
}

// What opens the talk, in the person's words as the agent reads them.
const chatPrefix = "Let's discuss this first: "

// Its Write-in row: Down to it, Enter opens `Your answer:`, which takes the words, seen
// there before Enter submits them.
const writeInSteps = (index: number, options: number, words: string): KeyStep[] => [
  ...moveTo(index, options + 1),
  { press: "\r" },
  {
    until: (rows) => rows.some((row) => row.trim() === "Your answer:"),
    timeoutMs: settle,
    why: "the write-in field open",
  },
  { type: words },
  shows(words, fieldRow, "its words in the write-in field"),
  { press: "\r" },
]

// Whether the screen shows question `index` as the call asked it: its text, and its options
// in order, then Write-in.
const showsQuestion = (rows: readonly string[], index: number, question: Question): boolean => {
  const now = asked(rows)
  if (now?.index !== index || collapse(now.question) !== collapse(question.question)) return false
  const labels = [...question.options, writeIn].map(collapse)
  // Its first option is the highlighted one, which the Downs count from.
  return (
    now.options.length === labels.length &&
    now.options.every(({ label }, at) => collapse(label) === labels[at]) &&
    now.options[0]!.marked
  )
}

const keysFor = (
  answer: RequestAnswer,
  questions: readonly Question[],
): readonly KeyStep[] | undefined => {
  if (answer.type !== "questions" || answer.answers.length !== questions.length) return undefined
  const steps: KeyStep[] = []
  for (const [at, each] of questions.entries()) {
    const index = at + 1
    const given = answer.answers.find(({ question }) => question === String(index))
    if (!given) return undefined
    const picked = [...new Set(given.options)].map(Number)
    if (picked.length !== given.options.length) return undefined
    if (
      !picked.every(
        (number) => Number.isInteger(number) && number >= 1 && number <= each.options.length,
      )
    )
      return undefined
    if (each.multi) {
      // Toggled by digit, each seen checked; Enter submits. Words aren't probed here.
      if (picked.length === 0 || given.text !== undefined) return undefined
      for (const number of picked.toSorted((one, other) => one - other)) {
        steps.push(
          { press: String(number) },
          {
            until: (rows) => {
              const now = asked(rows)
              return now?.index === index && now.options[number - 1]?.checked === true
            },
            timeoutMs: settle,
            why: `option ${number} checked`,
          },
        )
      }
      steps.push({ press: "\r" })
    } else if (given.text !== undefined) {
      // Its Write-in row: Down to it, Enter opens `Your answer:`, which takes the words.
      if (
        questions.length !== 1 ||
        picked.length !== 0 ||
        !plain(given.text) ||
        collapse(given.text) === ""
      )
        return undefined
      steps.push(...writeInSteps(index, each.options.length, given.text))
    } else {
      if (picked.length !== 1) return undefined
      steps.push(...moveTo(index, picked[0]!), { press: "\r" })
      if (index < questions.length)
        steps.push({
          until: (rows) => showsQuestion(rows, index + 1, questions[index]!),
          timeoutMs: settle,
          why: `question ${index + 1} shown, with its text and options`,
        })
    }
  }
  return steps
}

// ---- Plan review

// Its footer, above the prompt box: "1 artifact · /artifact to review". The review is at
// its start with the box empty (a draft there would take `/artifact` into itself) and
// the prompt idle (its bottom row offering shortcuts, not "esc to cancel"); the driver
// reads it again between keys, so it also reads with `/artifact` typed, or listed.
const reviewing = (rows: readonly string[]): { readonly start: boolean } | undefined => {
  const lines = rows.map((row) => row.trimEnd())
  const at = only(rowsLike(lines, /^\d+ artifacts? · \/artifact to review$/))
  if (at === undefined || !lines[at]!.trim().startsWith("1 artifact · ")) return undefined
  if (!rule(lines[at + 1] ?? "") || !rule(lines[at + 3] ?? "")) return undefined
  const composer = lines[at + 2]?.trim()
  const last = lines.findLast((row) => row.trim() !== "")?.trim()
  const start = composer === ">" && last?.startsWith("? for shortcuts") === true
  // Words typed in the box, as feedback or a draft, leave it the same dialog, with no keys.
  const typed = composer?.startsWith(">") === true && composer !== ">"
  return start || typed || (composer === ">" && review(rows)) ? { start } : undefined
}

const review = (rows: readonly string[]): boolean =>
  rows.some((row) => /^Action required \(1 left\)$/.test(row.trim())) &&
  rows.some((row) => /^›\s+□\s+new\s+\S+/.test(row.trim()))

// The prompt box's row, below the footer.
const composerRow = (rows: readonly string[]): string | undefined => {
  const at = rows.findIndex((row) => /^\d+ artifacts? · \/artifact to review$/.test(row.trim()))
  const row = at < 0 ? undefined : rows[at + 2]?.trim()
  return row?.startsWith(">") ? row.slice(1) : undefined
}

const reviewRead = (rows: readonly string[], request: RequestFacts): DialogRead | undefined => {
  const state = reviewing(rows)
  if (request.kind !== "plan" || request.tool !== "artifact" || !state) return undefined
  // `/artifact` lists what awaits review, where y approves and n rejects the first.
  const open: KeyStep[] = [
    { press: "/artifact" },
    { press: "\r" },
    { until: review, timeoutMs: settle, why: "the artifact review listed" },
  ]
  const dialog: ReadDialog = {
    type: "choices",
    title: "1 artifact to review",
    detail: null,
    options: [
      { id: "approve", label: "Approve", text: null },
      { id: "reject", label: "Reject", text: null },
      { id: "feedback", label: "Tell it what to change", text: "field" },
    ],
  }
  return {
    dialog,
    keys: (answer) => {
      if (answer.type !== "choice" || !state.start) return undefined
      if (answer.option === "approve" && answer.text === undefined) return [...open, { press: "y" }]
      if (answer.option === "reject" && answer.text === undefined) return [...open, { press: "n" }]
      // A plain prompt while the review waits is its feedback (probed: the model gets it
      // as the person's request, and the review is gone): typed into the empty box, with
      // neither y nor n, which would start a "[Rejected]" turn of their own first.
      // Not words that would run a command (/), open help (?), a shell (!) or a file picker (@, anywhere: its Enter would pick a file) from an empty box.
      if (
        answer.option === "feedback" &&
        answer.text !== undefined &&
        plain(answer.text) &&
        !/^\s*[/?!]|@/.test(answer.text)
      )
        return [
          { type: answer.text },
          shows(answer.text, composerRow, "its words in the prompt box"),
          { press: "\r" },
        ]
      return undefined
    },
    answered: (later) =>
      !later.some((row) => /^Action required \(\d+ left\)$/.test(row.trim())) &&
      !later.some((row) => /^\d+ artifacts? · \/artifact to review$/.test(row.trim())),
  }
}

const screenRequest = (rows: readonly string[]): ScreenRequest | undefined =>
  !reviewing(rows)?.start
    ? undefined
    : { kind: "plan", tool: "artifact", input: null, subject: "1 artifact to review" }

export const dialogs: DialogAdapter = {
  read: (rows, request) => {
    switch (request.kind) {
      case "permission":
        return confirmationRead(rows, request)
      case "question":
        return questionsRead(rows, request)
      case "plan":
        return reviewRead(rows, request)
    }
  },
  screenRequest,
}
