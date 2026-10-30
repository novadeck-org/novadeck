import type {
  AnswerableDialog,
  DialogRead,
  KeyStep,
  RequestFacts,
} from "@novadeck/harness-core/dialogs"
import type { RequestAnswer } from "@novadeck/protocol"

import {
  collapse,
  footerAfter,
  only,
  type Option,
  optionsFrom,
  rowsLike,
  shows,
  timeoutMs,
  typeable,
} from "./dialog-screen.js"
import { toolCall } from "./tools.js"

/**
 * Antigravity's ask_question (probed 2026-10-06, 1.2.14; fixtures/ask.probe.json):
 * `Question i/n: <question>`, its options, then `Write-in...`. Down and Enter pick one (a
 * digit selects at once too, but it is Down and Enter that were probed through every
 * question of several); in a multi-select a digit toggles and Enter submits; Write-in is
 * Down to its row, Enter, then `Your answer:` takes text and Enter.
 */

// A key that moves the highlight down.
const down = "\x1b[B"

// The row over ask_question's open write-in field.
const answerField = "Your answer:"

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
    field?.startsWith(answerField) === true &&
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
  const call = toolCall(input)
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
          timeoutMs,
          why: `option ${number} of question ${index} highlighted`,
        },
      ]

// The row after `Your answer:`, where a write-in's words appear.
const fieldRow = (rows: readonly string[]): string | undefined => {
  const at = rows.findLastIndex((row) => row.trim() === answerField)
  return at < 0 ? undefined : rows.slice(at + 1).find((row) => row.trim() !== "")
}

export const questions = (
  rows: readonly string[],
  request: RequestFacts,
): DialogRead | undefined => {
  const read = asked(rows)
  const callQuestions = questionsOf(request.input)
  if (!read || !callQuestions || read.total !== callQuestions.length) return undefined
  // Any state of the dialog reads as the same one, as the driver reads it again before
  // each key; only where it stands at its start do answers have keys.
  const shown = callQuestions[read.index - 1]!
  if (callQuestions.length > 1 && callQuestions.some(({ multi }) => multi)) return undefined
  if (read.multi !== shown.multi || collapse(read.question) !== collapse(shown.question))
    return undefined
  const labels = [...shown.options, writeIn].map(collapse)
  if (read.options.length !== labels.length) return undefined
  if (!read.options.every(({ label }, index) => collapse(label) === labels[index])) return undefined
  const start =
    read.index === 1 &&
    !read.writing &&
    read.options[0]!.marked &&
    !read.options.some(({ checked }) => checked === true)
  // Words answer only a lone single-choice question.
  const text = callQuestions.length === 1 && !callQuestions[0]!.multi
  const dialog: AnswerableDialog = {
    type: "questions",
    questions: callQuestions.map(({ question, options, multi }, index) => ({
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
      if (answer.type !== "chat") return keysFor(answer, callQuestions)
      // The words, said to open the talk, as the answer the agent reads.
      const words = answer.text === undefined ? undefined : `${chatPrefix}${answer.text}`
      return text && words !== undefined && typeable(answer.text!) && collapse(answer.text!) !== ""
        ? writeInSteps(1, callQuestions[0]!.options.length, words)
        : undefined
    },
    answered: (later) => {
      // Its write-in field is still it; any other question of the call, or a later one
      // with the same words, is the same dialog, and any other is none of this.
      if (later.some((row) => row.trim() === answerField)) return false
      const now = asked(later)
      if (now)
        return !callQuestions.some(({ question }) => collapse(question) === collapse(now.question))
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
    until: (rows) => rows.some((row) => row.trim() === answerField),
    timeoutMs,
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
  callQuestions: readonly Question[],
): readonly KeyStep[] | undefined => {
  if (answer.type !== "questions" || answer.answers.length !== callQuestions.length)
    return undefined
  const steps: KeyStep[] = []
  for (const [at, each] of callQuestions.entries()) {
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
            timeoutMs,
            why: `option ${number} checked`,
          },
        )
      }
      steps.push({ press: "\r" })
    } else if (given.text !== undefined) {
      // Its Write-in row: Down to it, Enter opens `Your answer:`, which takes the words.
      if (
        callQuestions.length !== 1 ||
        picked.length !== 0 ||
        !typeable(given.text) ||
        collapse(given.text) === ""
      )
        return undefined
      steps.push(...writeInSteps(index, each.options.length, given.text))
    } else {
      if (picked.length !== 1) return undefined
      steps.push(...moveTo(index, picked[0]!), { press: "\r" })
      if (index < callQuestions.length)
        steps.push({
          until: (rows) => showsQuestion(rows, index + 1, callQuestions[index]!),
          timeoutMs,
          why: `question ${index + 1} shown, with its text and options`,
        })
    }
  }
  return steps
}
