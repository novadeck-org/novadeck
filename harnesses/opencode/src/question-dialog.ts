import { refuse } from "@novadeck/harness-core/dialogs"
import type {
  AnswerableDialog,
  DialogRead,
  KeyStep,
  RequestFacts,
} from "@novadeck/harness-core/dialogs"
import type { RequestAnswer } from "@novadeck/protocol"

import { blockOf, only, shows, squash, timeoutMs, typeable } from "./dialog-screen.js"

/**
 * opencode's question dialog, its `question` tool (probed 2026-11-22, 1.19.6;
 * fixtures/dialogs.probe.json): the question, its numbered options with their descriptions in
 * rows of their own, a last `N. Type your own answer`, and a footer of keys. A digit picks its
 * option: in a question alone it answers at once, in one of several it moves to the next
 * question's tab, and from the last to a `Review` tab, where Enter submits; a multi-select's
 * (`(select all that apply)`, `[ ] label` rows) toggles it, and Tab moves on. The own answer's
 * digit opens a field in the row under it, whose Enter answers (or checks the row, in a
 * multi-select). With several questions, or a multi-select, a row of tabs, `Colour   Size
 * Confirm`, is over the question. The selected row and tab show only in colour, so nothing here
 * reads them; Down was not used, as it moved the selection of a multi-select's rows no further.
 * Escape dismisses the whole dialog, the tool fails and the turn goes on, so nothing here
 * presses it.
 */

const anchor = /^ *┃  (?:↑↓ select {2}enter submit|⇆ tab {2}).*esc dismiss\s*$/
const own = "Type your own answer"
const suffix = " (select all that apply)"

const tab = "\t"
const enter = "\r"

type Question = {
  readonly question: string
  readonly header: string
  readonly options: readonly { readonly label: string; readonly description: string }[]
  readonly multi: boolean
  /** Whether it offers the own answer: its `custom`, true unless the call said false. */
  readonly custom: boolean
}

// The questions of a `question.asked` event, each whole, or none.
const questionsOf = (input: unknown): Question[] | undefined => {
  const asked = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(asked)) return refuse("question.questionsOf.1")
  const questions: Question[] = []
  for (const each of asked as unknown[]) {
    const { question, header, options, multiple, custom } = (each ?? {}) as Record<string, unknown>
    if (typeof question !== "string" || question.trim() === "")
      return refuse("question.questionsOf.2")
    if (typeof header !== "string" || header.trim() === "") return refuse("question.questionsOf.3")
    if (!Array.isArray(options)) return refuse("question.questionsOf.4")
    const listed: Question["options"][number][] = []
    for (const option of options as unknown[]) {
      const { label, description } = (option ?? {}) as Record<string, unknown>
      if (typeof label !== "string" || label.trim() === "") return refuse("question.questionsOf.5")
      if (description !== undefined && typeof description !== "string")
        return refuse("question.questionsOf.6")
      listed.push({ label, description: description ?? "" })
    }
    if (multiple !== undefined && typeof multiple !== "boolean")
      return refuse("question.questionsOf.7")
    // The `question` tool's schema drops `custom`, so only a tool of opencode's own that asks with
    // `custom: false` (its plan review, `plan_exit`) sends one: its dialog has no own-answer row.
    if (custom !== undefined && typeof custom !== "boolean") return refuse("question.questionsOf.8")
    questions.push({
      question,
      header,
      options: listed,
      multi: multiple === true,
      custom: custom !== false,
    })
  }
  // As many options as a digit names, own answer included.
  return questions.length >= 1 &&
    questions.length <= 8 &&
    questions.every(
      ({ options, custom }) => options.length >= 1 && options.length + (custom ? 1 : 0) <= 9,
    )
    ? questions
    : refuse("question.questionsOf.9")
}

type Row = { readonly number: number; readonly text: string; readonly checked: boolean | undefined }

type State =
  | {
      readonly kind: "question"
      /** Which of the call's questions it shows. */
      readonly index: number
      readonly rows: readonly Row[]
      /** Whether its own answer's field is open, which shows a row under that option. */
      readonly writing: boolean
      /** What that row holds: its placeholder, or the words typed. */
      readonly field: string
    }
  | { readonly kind: "review" }

// Whether the call's questions show tabs: several, or any multi-select.
const tabbed = (questions: readonly Question[]): boolean =>
  questions.length > 1 || questions.some(({ multi }) => multi)

// The dialog on screen as one of the call's questions, or its review, read in full; undefined where
// the screen shows none, or one that is not this call's.
const stateOf = (rows: readonly string[], questions: readonly Question[]): State | undefined => {
  const block = blockOf(rows, anchor)
  if (!block) return refuse("question.stateOf.1")
  const lines = block.lines.map((line) => line.trimEnd())
  const last = lines.findLastIndex((line) => line.trim() !== "")
  const footer = lines[last]?.trim() ?? ""
  const filled = lines.slice(0, last).filter((line) => line.trim() !== "")
  if (tabbed(questions)) {
    const tabs = `${questions.map(({ header }) => header).join("")}Confirm`
    if (squash(filled[0] ?? "") !== squash(tabs) || !footer.startsWith("⇆ tab"))
      return refuse("question.stateOf.2")
  } else if (!footer.startsWith("↑↓ select")) {
    return refuse("question.stateOf.3")
  }
  const rest = tabbed(questions) ? filled.slice(1) : filled
  if (rest[0]?.trim() === "Review") {
    const answers = rest.slice(1)
    const headed = questions.every(({ header }) =>
      answers.some((line) => line.trim().startsWith(`${header}: `)),
    )
    return headed && footer === "⇆ tab  enter submit  esc dismiss"
      ? { kind: "review" }
      : refuse("question.stateOf.4")
  }
  // The question's rows, to the first numbered one; then the options.
  const firstOption = rest.findIndex((line) => /^\d+\. /.test(line))
  if (firstOption < 1) return refuse("question.stateOf.5")
  const words = squash(rest.slice(0, firstOption).join(" "))
  const index = only(
    questions.flatMap(({ question, multi }, at) =>
      squash(`${question}${multi ? suffix : ""}`) === words ? [at] : [],
    ),
  )
  if (index === undefined) return refuse("question.stateOf.6")
  const shown: { number: number; text: string; checked: boolean | undefined }[] = []
  for (const line of rest.slice(firstOption)) {
    const match = /^(\d+)\. (?:\[( |✓)\] )?(.*)$/.exec(line)
    if (match) {
      shown.push({
        number: Number(match[1]),
        text: match[3]!,
        checked: match[2] === undefined ? undefined : match[2] === "✓",
      })
    } else {
      const previous = shown.at(-1)
      if (!previous) return refuse("question.stateOf.7")
      previous.text = `${previous.text} ${line.trim()}`
    }
  }
  const asked = questions[index]!
  const total = asked.options.length + (asked.custom ? 1 : 0)
  if (shown.length !== total || !shown.every(({ number }, at) => number === at + 1))
    return refuse("question.stateOf.8")
  // A multi-select's rows all have a box, a single's none.
  if (shown.some(({ checked }) => (checked !== undefined) !== asked.multi))
    return refuse("question.stateOf.9")
  for (const [at, option] of asked.options.entries()) {
    if (squash(shown[at]!.text) !== squash(`${option.label}${option.description}`))
      return refuse("question.stateOf.10")
  }
  // What follows the own answer's label is the field's row: the placeholder, which is the label
  // again, or its words. A question that turns it off has no such row.
  let field = ""
  if (asked.custom) {
    const lastRow = shown.at(-1)!.text
    if (!squash(lastRow).startsWith(squash(own))) return refuse("question.stateOf.11")
    field = lastRow.slice(own.length).trim()
  }
  const writing = field !== ""
  return {
    kind: "question",
    index,
    rows: shown.map(({ number, text, checked }) => ({ number, text, checked })),
    writing,
    field,
  }
}

// The row under the own answer, as the field shows what is typed there.
const fieldRow = (questions: readonly Question[]) => (rows: readonly string[]) => {
  const now = stateOf(rows, questions)
  return now?.kind === "question" ? now.field : undefined
}

// A wait for question `index` to show with nothing picked in it yet.
const questionShown = (questions: readonly Question[], index: number): KeyStep => ({
  until: (rows) => {
    const now = stateOf(rows, questions)
    return (
      now?.kind === "question" &&
      now.index === index &&
      !now.writing &&
      now.rows.every(({ checked }) => checked !== true)
    )
  },
  timeoutMs,
  why: `question ${index + 1} shown, nothing picked`,
})

const reviewShown = (questions: readonly Question[]): KeyStep => ({
  until: (rows) => stateOf(rows, questions)?.kind === "review",
  timeoutMs,
  why: "the review of the answers shown",
})

// A wait for the own answer's field to open on question `index`.
const fieldOpen = (questions: readonly Question[], index: number): KeyStep => ({
  until: (rows) => {
    const now = stateOf(rows, questions)
    return now?.kind === "question" && now.index === index && now.writing
  },
  timeoutMs,
  why: "the own answer's field open",
})

// Whether option `number` of question `index` shows as checked.
const optionChecked = (questions: readonly Question[], index: number, number: number): KeyStep => ({
  until: (rows) => {
    const now = stateOf(rows, questions)
    return now?.kind === "question" && now.index === index && now.rows[number - 1]?.checked === true
  },
  timeoutMs,
  why: `option ${number} checked`,
})

// The words in the own answer's field: its digit, the field open, the words typed and seen, Enter.
const writeIn = (questions: readonly Question[], index: number, words: string): KeyStep[] => [
  { press: String(questions[index]!.options.length + 1) },
  fieldOpen(questions, index),
  { type: words },
  shows(words, fieldRow(questions), "its words in the own answer's field"),
  { press: enter },
]

// What follows a question's last key: the next question's tab, or the review.
const after = (questions: readonly Question[], index: number): KeyStep =>
  index + 1 < questions.length ? questionShown(questions, index + 1) : reviewShown(questions)

const keysFor = (
  answer: RequestAnswer,
  questions: readonly Question[],
): readonly KeyStep[] | undefined => {
  if (answer.type !== "questions" || answer.answers.length !== questions.length) return undefined
  const steps: KeyStep[] = []
  for (const [index, asked] of questions.entries()) {
    const given = answer.answers.find(({ question }) => question === String(index + 1))
    if (!given) return undefined
    const picked = [...new Set(given.options)].map(Number)
    if (picked.length !== given.options.length) return undefined
    if (
      !picked.every(
        (number) => Number.isInteger(number) && number >= 1 && number <= asked.options.length,
      )
    )
      return undefined
    if (
      given.text !== undefined &&
      (!asked.custom || !typeable(given.text) || squash(given.text) === "")
    )
      return undefined
    if (asked.multi) {
      // Each toggled by its digit and seen checked; Tab moves on, the last one to the review.
      if (picked.length === 0 && given.text === undefined) return undefined
      for (const number of picked.toSorted((one, other) => one - other))
        steps.push({ press: String(number) }, optionChecked(questions, index, number))
      if (given.text !== undefined)
        steps.push(
          ...writeIn(questions, index, given.text),
          optionChecked(questions, index, asked.options.length + 1),
        )
      steps.push({ press: tab }, after(questions, index))
    } else if (given.text !== undefined) {
      if (picked.length !== 0) return undefined
      steps.push(...writeIn(questions, index, given.text))
      if (tabbed(questions)) steps.push(after(questions, index))
    } else {
      if (picked.length !== 1) return undefined
      steps.push({ press: String(picked[0]) })
      if (tabbed(questions)) steps.push(after(questions, index))
    }
  }
  // A lone question answers with its digit or its words; the review waits for Enter.
  if (tabbed(questions)) steps.push({ press: enter })
  return steps
}

export const questions = (
  rows: readonly string[],
  request: RequestFacts,
): DialogRead | undefined => {
  const asked = questionsOf(request.input)
  if (!asked) return refuse("question.questions.1")
  const now = stateOf(rows, asked)
  if (!now) return refuse("question.questions.2")
  // Only where it stands at its start do answers have keys: the first question, nothing
  // picked, no field open. A later one is somewhere the person took it.
  const start =
    now.kind === "question" &&
    now.index === 0 &&
    !now.writing &&
    now.rows.every(({ checked }) => checked !== true)
  const dialog: AnswerableDialog = {
    type: "questions",
    questions: asked.map(({ question, header, options, multi, custom }, index) => ({
      id: String(index + 1),
      header,
      question,
      options: options.map(({ label, description }, at) => ({
        id: String(at + 1),
        label,
        description: description === "" ? null : description,
      })),
      multiSelect: multi,
      text: custom,
    })),
    // Set aside to talk over with Escape, which dismisses it and ends the turn; the person's
    // words go as the next prompt (probed 2026-11-22, 1.19.6: no model call followed).
    chat: "prompt",
  }
  return {
    dialog,
    keys: (answer) =>
      answer.type === "chat" ? [{ press: "\x1b" }] : start ? keysFor(answer, asked) : undefined,
    answered: (later) => {
      if (!later.some((row) => anchor.test(row))) return true
      // Still up, whichever tab it shows; another call's dialog, which reads as none of this
      // one's questions, is a new dialog.
      return stateOf(later, asked) === undefined
    },
  }
}

/**
 * Plan mode's review, `plan_exit` (probed 2026-11-22, 1.19.6, fixtures/dialogs.probe.json `qPlan`):
 * a question dialog of one question, Yes and No, whose call turns the own answer off, read as the
 * choices a plan approval is elsewhere. Yes switches to the build agent and sends the plan as
 * approved; No stays in plan mode, so the person's feedback may follow it as the next prompt.
 */
export const planReview = (
  rows: readonly string[],
  request: RequestFacts,
): DialogRead | undefined => {
  const found = questions(rows, request)
  if (!found || found.dialog.type !== "questions") return refuse("question.planReview.1")
  const [single] = found.dialog.questions
  if (found.dialog.questions.length !== 1 || !single || single.multiSelect || single.text)
    return refuse("question.planReview.2")
  const dialog: AnswerableDialog = {
    type: "choices",
    title: single.question,
    detail: null,
    options: single.options.map(({ id, label }, at) => ({
      id,
      label,
      text: at === 0 ? null : ("prompt" as const),
    })),
  }
  return {
    dialog,
    keys: (answer) =>
      answer.type === "choice"
        ? found.keys({
            type: "questions",
            dialog: answer.dialog,
            answers: [{ question: "1", options: [answer.option] }],
          })
        : undefined,
    answered: found.answered,
  }
}
