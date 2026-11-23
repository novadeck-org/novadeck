import type { ChatAnswer, ChatDialog } from "../conversation"
import type { AskQuestion, InboxAnswer } from "../inbox"

// An agent's ask of several questions, drawn and answered as a harness's dialog of questions is:
// the dialog it makes (its questions and options get ids by their place), the ask's answer that
// dialog's answer makes, and what that answer says, a line the Inbox keeps.

type QuestionsDialog = Extract<ChatDialog, { type: "questions" }>
type AskAnswer = Extract<InboxAnswer, { kind: "ask" }>["answer"]

const questionId = (at: number): string => `q${at}`

// The label the agent's pick carries, as a harness's own question tool has it at its end.
const recommended = /\(recommended\)\s*$/i
const labelOf = (question: AskQuestion, at: number): string => {
  const { label } = question.options[at]!
  return question.recommend === at && !recommended.test(label) ? `${label} (Recommended)` : label
}

// The dialog of the ask's questions, by the ask's id: the person may always write their own
// answer to each, and the questions can't be set aside for a chat, which the terminal is for.
export const askDialog = (id: string, questions: readonly AskQuestion[]): QuestionsDialog => ({
  type: "questions",
  id,
  chat: null,
  questions: questions.map((question, at) => ({
    id: questionId(at),
    header: question.header,
    question: question.question,
    options: question.options.map((option, index) => ({
      id: String(index),
      label: labelOf(question, index),
      description: option.summary,
    })),
    multiSelect: question.multiSelect,
    text: true,
  })),
})

// The ask's answer that the dialog's answer makes, one per question in its order; none for an
// answer of another kind, which the dialog never sends.
export const askAnswerOf = (
  questions: readonly AskQuestion[],
  answer: ChatAnswer,
): AskAnswer | undefined => {
  if (answer.type !== "questions") return undefined
  return {
    type: "questions",
    answers: questions.map((_, at) => {
      const given = answer.answers.find((each) => each.question === questionId(at))
      return {
        options: (given?.options ?? []).map(Number).filter((index) => Number.isInteger(index)),
        text: given?.text ?? "",
      }
    }),
  }
}

// What the answer says, a question to a part: its header (or the question), then what was
// picked and written.
export const questionsWords = (
  questions: readonly AskQuestion[],
  answers: Extract<AskAnswer, { type: "questions" }>["answers"],
): string =>
  questions
    .map((question, at) => {
      const { options = [], text = "" } = answers[at] ?? {}
      const picked = options.flatMap((index) => question.options[index]?.label ?? [])
      const words = text.trim()
      return `${question.header ?? question.question}: ${[...picked, ...(words ? [words] : [])].join(", ")}`
    })
    .join("; ")
