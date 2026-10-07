import type { ChatAnswer, ChatQuestion } from "../../model/conversation"
import { hasControlCharacters } from "../../model/prompt-refusal"

// What the person has picked and written for a dialog's questions, by question id, and the
// answer it makes. Pure, so the form's rules read apart from its markup.

export type Pick = { readonly options: readonly string[]; readonly text: string }
export type Picks = Readonly<Record<string, Pick>>

const none: Pick = { options: [], text: "" }

const of = (picks: Picks, question: ChatQuestion): Pick => picks[question.id] ?? none

// Picks an option: the only one of a single-select question (clearing what was written,
// since the answer is one or the other), or toggles it among a multi-select's.
export const choose = (picks: Picks, question: ChatQuestion, option: string): Picks => {
  const current = of(picks, question)
  if (question.multiSelect)
    return {
      ...picks,
      [question.id]: {
        ...current,
        options: current.options.includes(option)
          ? current.options.filter((each) => each !== option)
          : [...current.options, option],
      },
    }
  return { ...picks, [question.id]: { options: [option], text: "" } }
}

// Writes the person's own words: a single-select question then has no option picked.
export const write = (picks: Picks, question: ChatQuestion, text: string): Picks => {
  const current = of(picks, question)
  return {
    ...picks,
    [question.id]: {
      options: !question.multiSelect && text.trim() !== "" ? [] : current.options,
      text,
    },
  }
}

// The picks that still make sense for the questions a re-read dialog now has: an option
// that is gone is dropped, and the person's words stay.
export const reconcile = (picks: Picks, questions: readonly ChatQuestion[]): Picks =>
  Object.fromEntries(
    questions.flatMap((question) => {
      const pick = picks[question.id]
      if (!pick) return []
      const ids = new Set(question.options.map((option) => option.id))
      return [[question.id, { ...pick, options: pick.options.filter((id) => ids.has(id)) }]]
    }),
  )

export const answered = (picks: Picks, question: ChatQuestion): boolean => {
  const { options, text } = of(picks, question)
  return options.length > 0 || (question.text && text.trim() !== "")
}

// How many questions have an answer, for the form's progress.
export const answeredCount = (picks: Picks, questions: readonly ChatQuestion[]): number =>
  questions.filter((question) => answered(picks, question)).length

// Whether every question has one: the form may be submitted.
export const complete = (picks: Picks, questions: readonly ChatQuestion[]): boolean =>
  questions.every((question) => answered(picks, question))

// The answer to send: per question, the options in the order the dialog lists them, and the
// person's words trimmed, where there are any.
export const questionsAnswer = (
  dialog: string,
  picks: Picks,
  questions: readonly ChatQuestion[],
): ChatAnswer => ({
  type: "questions",
  dialog,
  answers: questions.map((question) => {
    const { options, text } = of(picks, question)
    const words = question.text ? text.trim() : ""
    return {
      question: question.id,
      options: question.options.map((each) => each.id).filter((id) => options.includes(id)),
      ...(words ? { text: words } : {}),
    }
  }),
})

// The answer of an option, with the person's words where it takes them.
export const choiceAnswer = (dialog: string, option: string, text?: string): ChatAnswer => {
  const words = text?.trim()
  return { type: "choice", dialog, option, ...(words ? { text: words } : {}) }
}

// The person's words to the agent in place of the questions' answers, which are set aside.
export const chatAnswer = (dialog: string, text: string): ChatAnswer => {
  const words = text.trim()
  return { type: "chat", dialog, ...(words ? { text: words } : {}) }
}

// Words for a dialog's own field, which takes one line: newlines and tabs become spaces.
export const oneLine = (text: string): string => text.replace(/[\r\n\t]+/g, " ")

// The words an answer carries to the agent, which are lost if they fail to follow it.
export const wordsOf = (answer: ChatAnswer): string =>
  (answer.type === "choice" || answer.type === "chat" ? answer.text : undefined) ?? ""

// Whether any of the person's own words hold a control character the agent's field can't take.
export const holdsControls = (picks: Picks, questions: readonly ChatQuestion[]): boolean =>
  questions.some(
    (question) => question.text && hasControlCharacters(picks[question.id]?.text ?? ""),
  )
