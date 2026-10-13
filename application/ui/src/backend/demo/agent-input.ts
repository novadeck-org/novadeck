import type { ChatAnswer, ChatDialog, ChatRequest } from "../../model/conversation"

// What the person types into an agent's terminal while a request waits: their line, read
// against the request's dialog the way the agent's TUI reads keys. Pure, so the surface
// only routes the result.

// The request an agent's screen asks about: the oldest still unanswered, else the oldest
// answered one the agent has yet to report settled.
export const shownRequest = (requests: readonly ChatRequest[]): ChatRequest | undefined =>
  requests.find((request) => !request.answered) ?? requests[0]

// The draft with the words an interrupted turn gives back appended to it, a space between.
export const withWords = (draft: string, words: string): string =>
  draft.trim() ? `${draft.trimEnd()} ${words}` : words

type QuestionAnswer = Extract<ChatAnswer, { type: "questions" }>["answers"][number]

export type LineResult =
  // Muted text under the dialog, for a line it can't take.
  | { readonly type: "note"; readonly text: string }
  // A question taken; the next one is up.
  | { readonly type: "next"; readonly answers: readonly QuestionAnswer[] }
  | { readonly type: "answer"; readonly answer: ChatAnswer }

const numbers = /^\d+(?:[\s,]+\d+)*$/

// The 1-based picks of a line such as "2" or "1 3", or undefined where it isn't numbers.
const picks = (line: string): number[] | undefined =>
  numbers.test(line) ? [...new Set(line.split(/[\s,]+/).map(Number))] : undefined

export const readLine = (
  line: string,
  // A form or a raw dialog the screen doesn't answer: a line goes to the agent as a prompt.
  dialog: Extract<ChatDialog, { type: "choices" | "questions" }>,
  answers: readonly QuestionAnswer[],
): LineResult => {
  const text = line.trim()
  if (dialog.type === "choices") {
    const [, number, words] = /^(\d+)(?:\s+(.*))?$/.exec(text) ?? []
    if (!number) return { type: "note", text: "Type an option's number." }
    const option = dialog.options[Number(number) - 1]
    if (!option) return { type: "note", text: `No option ${number}.` }
    return {
      type: "answer",
      answer: {
        type: "choice",
        dialog: dialog.id,
        option: option.id,
        ...(option.text && words && { text: words }),
      },
    }
  }
  const question = dialog.questions[answers.length]
  if (!question) return { type: "note", text: "Nothing left to answer." }
  const chosen = picks(text)
  if (!chosen) return { type: "note", text: "Type an option's number." }
  const bad = chosen.find((number) => !question.options[number - 1])
  if (bad) return { type: "note", text: `No option ${bad}.` }
  if (chosen.length > 1 && !question.multiSelect) return { type: "note", text: "Pick one option." }
  const next = [
    ...answers,
    {
      question: question.id,
      options: chosen.map((number) => question.options[number - 1]!.id),
    },
  ]
  return next.length < dialog.questions.length
    ? { type: "next", answers: next }
    : {
        type: "answer",
        answer: { type: "questions", dialog: dialog.id, answers: next },
      }
}
