import type { DialogRead, RequestFacts } from "@novadeck/harness-core/dialogs"
import type { Fields } from "@novadeck/harness-core/tools"

import {
  choices,
  digit,
  digitKeys,
  editorHintFlat,
  Enter,
  fieldsOf,
  flat,
  idle,
  landed,
  marked,
  nonBlank,
  numbered,
  timeoutMs,
  typeable,
} from "./dialog-screen.js"

/**
 * Claude Code's ExitPlanMode dialog: "Ready to code?" over a plan it wrote to a file, whose
 * `1` or `2` answers at once and whose `3` opens a field for the feedback; or, for a plan
 * mode left with no plan, the shorter "Exit plan mode?".
 */

const planTitle = /^ {3}Exit plan mode\?$/
const planAsk = "Claude has written up a plan and is ready to execute. Would you like to proceed?"
const planQuestion = /Would you like to proceed\?$/
const planOption = /^ {3}(❯| ) (\d+)\. (.+)$/
const shortOption = /^ {4}(❯| ) (\d+)\. (.+)$/
const planHint = /^ {8}shift\+tab to approve with this feedback$/
const feedback = "Tell Claude what to change"

const planGone = (later: readonly string[]): boolean =>
  !later.some((each) => planTitle.test(each) || planQuestion.test(each)) && idle(later)

// "Ready to code?", asked at row `at`: the plan's file names this request.
const readyToCode = (
  rows: readonly string[],
  at: number,
  file: string | undefined,
): DialogRead | undefined => {
  const name = file?.split("/").pop()
  if (!name) return undefined
  const before = rows.slice(0, at).findLastIndex((each) => each !== "")
  const lines = [rows[before] ?? "", rows[at]!].map((each) => each.trim())
  const asked = flat(lines.join(" "))
  if (asked !== flat(planAsk) && flat(lines[1]!) !== flat(planAsk)) return undefined
  const read = numbered(rows, at + 1, planOption, /^ {9,}\S/, planHint)
  if (!read || read.options.length !== 3 || read.options[2]!.label !== feedback) return undefined
  // With the highlight on the field a digit would be typed into it.
  if (read.options[2]!.marker) return undefined
  // The footer wraps with the width; the file is its last word.
  const footer = flat(read.rest.join(""))
  if (!editorHintFlat.test(footer) || !footer.endsWith(flat(name))) return undefined
  return choices({
    title: "Ready to code?",
    detail: null,
    options: read.options,
    keys: (option, answer) => {
      if (option.n !== 3) return digitKeys(option, answer)
      const key = digit(option.n)
      const words = answer.text
      if (!key || words === undefined || !typeable(words)) return undefined
      return [
        { press: key },
        {
          until: (later) => marked(later, planOption, 3),
          timeoutMs,
          why: "the feedback field open",
        },
        { type: words },
        {
          until: (later) => landed(later, planOption, 3, words),
          timeoutMs,
          why: "the words in the feedback field",
        },
        { press: Enter },
      ]
    },
    answered: planGone,
    field: 3,
  })
}

// "Exit plan mode?", for no plan and no file.
const exitPlanMode = (
  rows: readonly string[],
  input: Fields,
  file: string | undefined,
): DialogRead | undefined => {
  const at = rows.findLastIndex((each) => planTitle.test(each))
  if (at < 0 || file !== undefined || nonBlank(input.plan) !== undefined) return undefined
  const says = rows.findIndex((each, index) => index > at && each !== "")
  if (rows[says] !== "    Claude wants to exit plan mode") return undefined
  const read = numbered(rows, says + 1, shortOption, /^ {9,}\S/)
  if (!read || read.options.length !== 2 || read.rest.length > 0) return undefined
  if (read.options[1]!.label !== "No") return undefined
  return choices({
    title: "Exit plan mode?",
    detail: null,
    options: read.options,
    keys: digitKeys,
    answered: planGone,
  })
}

export const plan = (rows: readonly string[], facts: RequestFacts): DialogRead | undefined => {
  if (facts.kind !== "plan" || facts.tool !== "ExitPlanMode") return undefined
  const input = fieldsOf(facts.input)
  if (!input) return undefined
  const file = nonBlank(input.planFilePath)?.replaceAll("\\", "/")
  const asked = rows.findLastIndex((each) => planQuestion.test(each))
  return asked >= 0 ? readyToCode(rows, asked, file) : exitPlanMode(rows, input, file)
}
