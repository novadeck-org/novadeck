import type { KeyStep, RequestFacts } from "@novadeck/harness-core/dialogs"
import type { RequestAnswer } from "@novadeck/protocol"

import { asyncTool } from "./async-question.js"
import {
  clean,
  composerShown,
  fieldsOf,
  firstOption,
  labelled,
  optionsAt,
  type Parsed,
  type Row,
  squash,
} from "./dialog-screen.js"

type AsyncQuestion = {
  readonly title: string
  /** Its options, none when it takes the person's words alone. */
  readonly options: readonly string[]
}

/**
 * The questions a `request_user_input_async` call asks, or undefined for any shape not
 * understood.
 */
const asyncQuestionsOf = (input: unknown): readonly AsyncQuestion[] | undefined => {
  const list = fieldsOf(input)?.questions
  if (!Array.isArray(list) || list.length === 0 || list.length > 8) return undefined
  const questions: AsyncQuestion[] = []
  for (const entry of list) {
    const each = fieldsOf(entry)
    if (!each || typeof each.title !== "string" || each.title.trim() === "") return undefined
    const given = each.options
    if (given !== undefined && given !== null) {
      if (!Array.isArray(given) || given.length === 0 || given.length > 8) return undefined
      if (!given.every((option) => typeof option === "string" && option.trim() !== "")) {
        return undefined
      }
    }
    questions.push({
      title: each.title,
      options: Array.isArray(given) ? (given as string[]) : [],
    })
  }
  return questions
}

const queuedHeading = /^\s*• Queued follow-up inputs\s*$/
const answeredHeading = /^\s*• Messages to be submitted after next tool call/
const asyncPanel = /^\s*\? (\d+) questions?(?: · \S+)?\s*$/
// Its hints' words are fixed; their keys are drawn as the platform spells them (`^]` here,
// `⌃]` on macOS, as the approvals' ctrl) and may be rebound, so any key reads.
const asyncFooter = /^\s*\S+ submit {2,}\S+ skip {2,}\S+ main prompt(?: {2,}\S+ next question)?\s*$/
// The key the panel says opens the picker, as Linux and Windows spell it and as macOS
// does (`⇧`, as its ctrl is `⌃`): shift+←, the key pressed to open it.
const asyncOpens = /^\s*(?:shift\+|⇧ ?)← to answer\s*$/
const asyncOther = "Other"

type Picker = {
  /** The question on it: its title, as the screen wraps it, squashed. */
  readonly title: string
  /** Its option rows, the Other row last; none for a free-text question. */
  readonly rows: readonly Row[]
  /** Whether it is a free-text question, taking the person's words alone. */
  readonly words: boolean
  /** How many questions it says wait, where it says (`1 of 2`). */
  readonly of: number | undefined
}

/**
 * The picker at the bottom of the screen (its footer is the screen's last row), or
 * undefined: under Codex's own heading, an optional `k of n`, the question's title, then
 * its numbered options or `Type your answer`.
 */
const pickerOf = (lines: readonly string[]): Picker | undefined => {
  if (lines.length === 0 || !asyncFooter.test(lines.at(-1)!)) return undefined
  const heading = lines.findLastIndex((line) => queuedHeading.test(line))
  if (heading < 0) return undefined
  let at = heading + 1
  const count = /^\s*1 of (\d+)\s*$/.exec(lines[at] ?? "")
  if (count) at += 1
  const start = at
  const first = firstOption(lines, start)
  const free = lines.findIndex((line, i) => i >= start && /^\s*Type your answer\s*$/.test(line))
  if (first >= 0 && free >= 0) return undefined
  const end = first >= 0 ? first : free
  if (end <= start) return undefined
  const { rows, next } = first >= 0 ? optionsAt(lines, first) : { rows: [], next: free + 1 }
  // Nothing but the footer follows the options.
  if (next !== lines.length - 1) return undefined
  return {
    title: squash(lines.slice(start, end).join("")),
    rows,
    words: first < 0,
    of: count ? Number(count[1]) : undefined,
  }
}

/** Whether the picker is on `question` with its options in order and one row after them. */
const optionsOn = (picker: Picker | undefined, question: AsyncQuestion): picker is Picker => {
  if (!picker || picker.title !== squash(question.title)) return false
  const { rows } = picker
  return (
    rows.length === question.options.length + 1 &&
    question.options.every((option, i) => labelled(rows[i]!.head, option))
  )
}

/**
 * Whether the picker is on `question`: its options in order and the Other row last, or, for
 * a question with none, its free-text field.
 */
const pickerOn = (picker: Picker | undefined, question: AsyncQuestion): boolean =>
  question.options.length === 0
    ? picker?.title === squash(question.title) && picker.words
    : optionsOn(picker, question) && labelled(picker.rows.at(-1)!.head, asyncOther)

/** Whether the picker is on `question` with its Other row, not any other, highlighted. */
const otherMarked = (picker: Picker | undefined, question: AsyncQuestion): boolean =>
  pickerOn(picker, question) && picker!.rows.at(-1)!.marked

/**
 * Whether the picker on `question` shows the person's `text` where its answer goes: on its
 * Other row, which the words replace (the row's first characters, as the line shows what
 * fits), or under a free-text question's title in place of `Type your answer`.
 */
const wordsShown = (lines: readonly string[], question: AsyncQuestion, text: string): boolean => {
  if (lines.length === 0 || !asyncFooter.test(lines.at(-1)!)) return false
  const start = squash(text).slice(0, 40)
  if (question.options.length === 0) {
    const heading = lines.findLastIndex((line) => queuedHeading.test(line))
    if (heading < 0) return false
    const body = lines.slice(heading + 1, -1)
    const [counted] = body
    const shown = squash(
      (counted !== undefined && /^\s*1 of \d+\s*$/.test(counted) ? body.slice(1) : body).join(""),
    )
    return shown.startsWith(squash(question.title) + start)
  }
  // The words replace the Other row's label.
  const picker = pickerOf(lines)
  if (!optionsOn(picker, question)) return false
  const row = picker.rows.at(-1)!
  return row.marked && squash(row.text).startsWith(start)
}

/**
 * The `? n question(s)` panel's count at the screen's bottom, where `shift+← to answer` is
 * under it.
 */
const panelOf = (lines: readonly string[]): number | undefined => {
  const at = lines.findLastIndex((line) => asyncPanel.test(line))
  if (at < 0 || lines.findLastIndex((line) => queuedHeading.test(line)) !== at - 1) return undefined
  if (!asyncOpens.test(lines[at + 1] ?? "")) return undefined
  return Number(asyncPanel.exec(lines[at]!)![1])
}

/**
 * Whether Codex is working: its status row, `• Working (12s • esc to interrupt)`, whose
 * bullet blinks to `◦` and back while it works, and whose word may be the header of the
 * model's reasoning instead of "Working": its time and `esc to interrupt` stay.
 */
const working = (lines: readonly string[]): boolean =>
  lines.some((line) => /^\s*[•◦] .*\(\d[^()]*esc to interrupt\)\s*$/.test(line))

/**
 * Whether the screen is Codex idle at its composer, nothing queued or asked on it. Whether
 * the composer is empty is the prompt's own check, through the box: empty, it shows one of
 * several suggestions drawn dim, which only its colour tells from a draft.
 */
const idle = (rows: readonly string[]): boolean => {
  const lines = clean(rows)
  if (!composerShown(rows) || working(lines)) return false
  if (lines.some((line) => queuedHeading.test(line) || answeredHeading.test(line))) return false
  return lines.slice(-4).some((line) => line.startsWith("›"))
}

/** Whether the queued answers block shows the answer to `title`: its `↳ > ` line. */
const queuedAnswer = (lines: readonly string[], title: string): boolean => {
  const block = lines.findIndex((line) => answeredHeading.test(line))
  if (block < 0) return false
  const shown = lines.slice(block + 1)
  const at = shown.findIndex((line) => /^\s*↳ > /.test(line))
  return squash(shown.slice(at).join("")).includes(`↳>${squash(title)}`)
}

/**
 * A `request_user_input_async` call's questions still to answer: behind its panel or in its
 * picker while the turn runs, or as the next prompt once the turn has dropped them.
 */
export const asyncQuestions = (
  lines: readonly string[],
  facts: RequestFacts,
): Parsed | undefined => {
  if (facts.kind !== "question" || facts.tool !== asyncTool) return undefined
  const asked = asyncQuestionsOf(facts.input)
  if (!asked) return undefined
  // Codex takes each question's answer on its own: those answered already are gone from
  // its panel and picker, and what remains is what the dialog asks.
  const answered = new Set(facts.answered ?? [])
  const questions = asked.filter((_, index) => !answered.has(index))
  if (questions.length === 0) return undefined
  const [first] = questions
  const picker = pickerOf(lines)
  const panel = panelOf(lines)
  // Where the answer goes: the panel's or picker's keys while the turn runs, a prompt after.
  let opening: readonly KeyStep[] | undefined
  if (picker) {
    // The picker is open on this request's first question, with all of them still to answer.
    if (!pickerOn(picker, first!)) return undefined
    if (picker.of !== undefined ? picker.of !== questions.length : questions.length !== 1) {
      return undefined
    }
    opening = []
  } else if (panel !== undefined) {
    if (panel !== questions.length) return undefined
    opening = [
      { press: "\x1b[1;2D" },
      {
        until: (screen) => pickerOn(pickerOf(clean(screen)), first!),
        timeoutMs: 5000,
        why: "the picker on the first question",
      },
    ]
  }
  const gone = opening === undefined
  // After the turn the questions are dropped, and the answer is the next prompt, which
  // quotes each on a line of its own: one that runs over lines quotes as nothing.
  if (gone && (!idle(lines) || questions.some(({ title }) => /[\r\n]/.test(title.trim()))))
    return undefined

  return {
    dialog: {
      type: "questions",
      chat: null,
      questions: questions.map((each, k) => ({
        id: String(k + 1),
        header: null,
        question: each.title,
        options: each.options.map((label, i) => ({ id: String(i + 1), label, description: null })),
        multiSelect: false,
        text: true,
      })),
    },
    // The last answer gone in: its line among the queued messages, or no panel or picker
    // of Codex's left at all (a later question of its own would keep one).
    answered: (later) => {
      const shown = clean(later)
      return (
        queuedAnswer(shown, questions.at(-1)!.title) ||
        (pickerOf(shown) === undefined &&
          panelOf(shown) === undefined &&
          !shown.some((line) => queuedHeading.test(line)))
      )
    },
    keys: (answer) => {
      if (opening === undefined) return undefined
      const given = answersOf(answer, questions)
      if (!given) return undefined
      const steps: KeyStep[] = [...opening]
      for (const [k, each] of questions.entries()) {
        const one = given[k]!
        if (k > 0) {
          steps.push({
            until: (screen) => pickerOn(pickerOf(clean(screen)), each),
            timeoutMs: 5000,
            why: `question ${k + 1} of ${questions.length}`,
          })
        }
        if (one.option !== undefined) {
          steps.push({ press: String(one.option + 1) })
          continue
        }
        if (each.options.length > 0) {
          // A digit past the options only highlights Other; its row then takes the words.
          steps.push({ press: String(each.options.length + 1) })
          steps.push({
            until: (screen) => otherMarked(pickerOf(clean(screen)), each),
            timeoutMs: 5000,
            why: "the Other row highlighted",
          })
        }
        steps.push({ type: one.text })
        steps.push({
          until: (screen) => wordsShown(clean(screen), each, one.text),
          timeoutMs: 5000,
          why: "the words in the answer's row",
        })
        steps.push({ press: "\r" })
      }
      return steps
    },
    // Only once the turn has dropped its questions: while they show, the keys answer.
    ...(gone && {
      prompt: (answer: RequestAnswer) => {
        const given = answersOf(answer, questions)
        if (!given) return undefined
        return questions
          .map((each, k) => {
            const one = given[k]!
            const said = one.option === undefined ? one.text : each.options[one.option]!
            return `> ${each.title.trim()}\n\n${said.trim()}`
          })
          .join("\n\n")
      },
    }),
  }
}

/**
 * The answer to each of `questions` in turn, as an option's index or the person's words,
 * or undefined for an answer that doesn't give exactly one of those to every question.
 */
const answersOf = (
  answer: RequestAnswer,
  questions: readonly AsyncQuestion[],
): readonly { readonly option?: number; readonly text: string }[] | undefined => {
  if (answer.type !== "questions" || answer.answers.length !== questions.length) return undefined
  const found: { option?: number; text: string }[] = []
  for (const [k, each] of questions.entries()) {
    const given = answer.answers.filter(({ question }) => question === String(k + 1))
    if (given.length !== 1) return undefined
    const { options, text } = given[0]!
    if (options.length + (text === undefined ? 0 : 1) !== 1) return undefined
    if (text !== undefined) {
      if (text.trim() === "" || ["\r", "\n", "\x1b"].some((key) => text.includes(key)))
        return undefined
      found.push({ text })
      continue
    }
    const picked = each.options.findIndex((_, i) => String(i + 1) === options[0])
    if (picked < 0) return undefined
    found.push({ option: picked, text: each.options[picked]! })
  }
  return found
}
