import type { KeyStep, RequestFacts } from "@novadeck/harness-core/dialogs"
import { fieldsOf } from "@novadeck/harness-core/fields"

import {
  clean,
  firstOption,
  labelled,
  optionsAt,
  type Parsed,
  type Row,
  squash,
} from "./dialog-screen.js"

type Question = {
  readonly id: string
  readonly header: string | null
  readonly question: string
  readonly options: readonly { readonly label: string; readonly description: string | null }[]
}

/** The questions a `request_user_input` call asks, or undefined for any shape not understood. */
const questionsOf = (input: unknown): readonly Question[] | undefined => {
  const list = fieldsOf(input)?.questions
  if (!Array.isArray(list) || list.length === 0 || list.length > 8) return undefined
  const questions: Question[] = []
  for (const entry of list) {
    const each = fieldsOf(entry)
    if (!each || typeof each.id !== "string" || typeof each.question !== "string") return undefined
    if (!Array.isArray(each.options) || each.options.length === 0 || each.options.length > 8) {
      return undefined
    }
    const options: Question["options"][number][] = []
    for (const raw of each.options) {
      const option = fieldsOf(raw)
      if (!option || typeof option.label !== "string" || option.label === "") return undefined
      options.push({
        label: option.label,
        description: typeof option.description === "string" ? option.description : null,
      })
    }
    questions.push({
      id: each.id,
      header: typeof each.header === "string" ? each.header : null,
      question: each.question,
      options,
    })
  }
  return new Set(questions.map(({ id }) => id)).size === questions.length ? questions : undefined
}

const otherLabel = "None of the above"
const questionHeader = /^\s*Question (\d+)\/(\d+)(?: \(\d+ unanswered\))?$/

/** The line of the screen's question header and the question it is on, or undefined. */
const headerOf = (
  lines: readonly string[],
): { readonly at: number; readonly k: number; readonly of: number } | undefined => {
  const at = lines.findLastIndex((line) => questionHeader.test(line))
  const found = at < 0 ? null : questionHeader.exec(lines[at]!)
  return found ? { at, k: Number(found[1]), of: Number(found[2]) } : undefined
}

/**
 * The option rows of question `k` (from 0) of `questions` where the screen shows it as the
 * request lists it: its header and text, its options in order and perhaps "None of the
 * above" after them, with the notes closed, so a digit picks the row the answer means.
 * Undefined for any other screen.
 */
const questionRows = (
  lines: readonly string[],
  questions: readonly Question[],
  k: number,
): readonly Row[] | undefined => {
  const header = headerOf(lines)
  if (header?.k !== k + 1 || header.of !== questions.length) return undefined
  const first = firstOption(lines, header.at + 1)
  if (first < 0) return undefined
  const question = questions[k]!
  if (squash(lines.slice(header.at + 1, first).join("")) !== squash(question.question)) {
    return undefined
  }
  const { rows, next } = optionsAt(lines, first)
  const count = question.options.length
  if (rows.length !== count && rows.length !== count + 1) return undefined
  if (!question.options.every((option, i) => labelled(rows[i]!.head, option.label))) {
    return undefined
  }
  if (rows.length > count && !labelled(rows[count]!.head, otherLabel)) return undefined
  // Words already typed in its notes, or anything else after the options, is not a screen
  // whose digits answer.
  if (lines.slice(next).some((line) => /^\s*›/.test(line) || /clear notes/.test(line))) {
    return undefined
  }
  return rows
}

/**
 * Whether the notes field's own row, the `›` line under the options, starts with the words
 * (their first characters, as the field shows what fits): not any other row.
 */
const notesStart = (rows: readonly string[], text: string): boolean => {
  const lines = clean(rows)
  const top = headerOf(lines)
  const first = top ? firstOption(lines, top.at + 1) : -1
  if (first < 0) return false
  const { next } = optionsAt(lines, first)
  const end = lines.findIndex((line, at) => at >= next && /clear notes/.test(line))
  if (end < 0 || !/^\s*›/.test(lines[next] ?? "")) return false
  const typed = squash(lines.slice(next, end).join("")).replace(/^›/, "")
  return typed.startsWith(squash(text).slice(0, 40))
}

/**
 * A `request_user_input` call's questions, read from its first: a digit answers each, and
 * words go in the notes of the row they belong to.
 */
export const questions = (lines: readonly string[], facts: RequestFacts): Parsed | undefined => {
  if (facts.kind !== "question" || facts.tool !== "request_user_input") return undefined
  const asked = questionsOf(facts.input)
  const rows = asked && questionRows(lines, asked, 0)
  if (!asked || !rows) return undefined
  const other = rows.length === asked[0]!.options.length + 1
  const highlighted = Math.max(
    0,
    rows.findIndex((row) => row.marked),
  )

  return {
    dialog: {
      type: "questions",
      // Esc abandons the call and interrupts the turn: the person's words then go as the
      // next prompt, which the model sees after "aborted by user" (probed 0.159.3).
      chat: "prompt",
      questions: asked.map((each) => ({
        id: each.id,
        header: each.header,
        question: each.question,
        options: each.options.map(({ label, description }, i) => ({
          id: String(i + 1),
          label,
          description,
        })),
        multiSelect: false,
        // Only the first question's rows are on screen to read; a later one's aren't
        // vouched for, so it takes no words.
        text: other && each === asked[0],
      })),
    },
    keys: (answer) => {
      if (answer.type === "chat") return [{ press: "\x1b" }]
      if (answer.type !== "questions" || answer.answers.length !== asked.length) return undefined
      const steps: KeyStep[] = []
      for (const [k, each] of asked.entries()) {
        const given = answer.answers.filter(({ question: id }) => id === each.id)
        if (given.length !== 1) return undefined
        const { options, text } = given[0]!
        if (options.length > 1 || (options.length === 0 && text === undefined)) return undefined
        if (text !== undefined && !(other && k === 0)) return undefined
        const picked =
          options[0] === undefined
            ? undefined
            : each.options.findIndex((_, i) => String(i + 1) === options[0])
        if (picked === -1) return undefined
        if (k > 0) {
          steps.push({
            until: (screen) => questionRows(clean(screen), asked, k) !== undefined,
            timeoutMs: 5000,
            why: `question ${k + 1} of ${asked.length}`,
          })
        }
        if (text === undefined) {
          steps.push({ press: String(picked! + 1) })
          continue
        }
        // Words go in the notes of the row they belong to; a digit would submit instead.
        const target = picked ?? each.options.length
        const from = k === 0 ? highlighted : 0
        const move = target > from ? "\x1b[B" : "\x1b[A"
        for (let step = 0; step < Math.abs(target - from); step += 1) steps.push({ press: move })
        steps.push({
          until: (screen) => {
            const shown = clean(screen)
            const top = headerOf(shown)
            const marked = top ? optionsAt(shown, firstOption(shown, top.at + 1)).rows : []
            return marked.findIndex((row) => row.marked) === target
          },
          timeoutMs: 5000,
          why: "the row for the words highlighted",
        })
        steps.push({ press: "\t" })
        steps.push({
          until: (screen) => screen.some((line) => /clear notes/.test(line)),
          timeoutMs: 5000,
          why: "the notes field open",
        })
        steps.push({ type: text })
        steps.push({
          until: (screen) => notesStart(screen, text),
          timeoutMs: 5000,
          why: "the words in the notes field",
        })
        steps.push({ press: "\r" })
      }
      return steps
    },
  }
}
