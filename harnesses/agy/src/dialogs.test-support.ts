import type { ScreenText } from "@novadeck/emulator/headless"
import type { DialogRead, KeyStep, RequestFacts } from "@novadeck/harness-core/dialogs"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import type { RequestAnswer } from "@novadeck/protocol"

import { dialogs } from "./dialogs.js"

// What Antigravity's dialog tests share: the probe's screens, the requests and answers a
// test gives, and the keys and waits it reads back.

export type Screens = { [name: string]: ScreenText }
export const { scenarios } = loadProbe(import.meta.dirname, "ask.probe.json") as {
  scenarios: {
    command: { pending: Screens }
    twin: { first: ScreenText; second: ScreenText }
    write_to_file: { pending: Screens }
    ask_question: {
      pending: Screens
      multiSelect: Screens
      twoQuestions: Screens
      writeIn: ScreenText
    }
    plan_feedback: { afterWrite: Screens; review: Screens }
    answered: { [name: string]: ScreenText }
  }
}
export const {
  command,
  write_to_file: write,
  ask_question: ask,
  plan_feedback: planFeedback,
} = scenarios
export const gone = scenarios.answered

export const run = (text: string) => ({
  name: "run_command",
  args: { CommandLine: text, Cwd: "/tmp/sandbox/project" },
})
export const colours = (options: string[], multi = false) => ({
  question: "Which colour?",
  options,
  is_multi_select: multi,
})
export const asking = (...questions: object[]) => ({ name: "ask_question", args: { questions } })
export const permissionFacts = (input: unknown): RequestFacts => ({
  kind: "permission",
  tool: "confirmation",
  cwd: null,
  input,
})
export const questionFacts = (input: unknown): RequestFacts => ({
  kind: "question",
  tool: "ask_question",
  cwd: null,
  input,
})
export const colour = asking(colours(["Red", "Green", "Blue"]))

export const read = (rows: readonly string[], request: RequestFacts): DialogRead => {
  const found = dialogs.read(rows, request)
  if (!found) throw new Error("the dialog went unrecognised")
  return found
}
export const same = (rows: readonly string[], from: string | RegExp, to: string): string[] => {
  const index = rows.findIndex((row) => (typeof from === "string" ? row === from : from.test(row)))
  if (index < 0) throw new Error(`no row ${String(from)}`)
  return rows.with(index, to)
}
export const without = (rows: readonly string[], pattern: RegExp): string[] =>
  rows.filter((row) => !pattern.test(row))

// What a step list presses and types, with its waits left out.
export const sent = (steps: readonly KeyStep[] | undefined) =>
  steps?.flatMap((step) =>
    "press" in step ? [step.press] : "type" in step ? [`"${step.type}"`] : [],
  )
// The screens a step list's waits ask for, in order.
export const waits = (steps: readonly KeyStep[] | undefined) =>
  steps?.flatMap((step) => ("until" in step ? [step.until] : []))
export const questionsAnswer = (
  ...answers: { question: string; options: string[]; text?: string }[]
) => ({ type: "questions", dialog: "d", answers }) satisfies RequestAnswer
export const chat = (text?: string) =>
  ({ type: "chat", dialog: "d", ...(text !== undefined && { text }) }) satisfies RequestAnswer
export const choice = (option: string, text?: string) =>
  ({
    type: "choice",
    dialog: "d",
    option,
    ...(text !== undefined && { text }),
  }) satisfies RequestAnswer
