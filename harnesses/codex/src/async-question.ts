import { callId } from "@novadeck/harness-core/decode"

/**
 * The tool Codex offers to ask without waiting (0.162.1 on, to a model that lists it; see
 * `decode`).
 */
export const asyncTool = "request_user_input_async"

/**
 * An async question's request by its call's id, which its answers name (their
 * `questionItemId` carries it): the actor is left out, for the answer's prompt is the
 * root's whoever asked.
 */
export const asyncRequestId = (call: string): string => callId(null, asyncTool, { call })

// The prompt Codex gives the model for the answers to its async questions (0.165.0): one
// JSON array between the tags, an object per answered question, its `questionItemId` a
// JSON array of the tool, the call's id and the question's place (probed 2026-10-29), with
// the question and the person's answer as text. Each question answered comes as a reply of
// its own (0.166.0, fixtures/ask.probe.0.166.0.json).
const asyncReply =
  /^\s*<send_user_message_question_reply>\s*(\[[\s\S]*\])\s*<\/send_user_message_question_reply>\s*$/

/**
 * The questions a prompt answers by quoting them as Codex does once the turn that asked
 * ended: `> ` and the question on a line of its own, a blank line, then the answer.
 */
export const quoted = (prompt: string): readonly string[] =>
  [...prompt.replace(/\r\n?/g, "\n").matchAll(/(?:^|\n\n)> ([^\n]+)\n\n(?=\S)/g)].map(
    ([, question]) => question!.trim(),
  )

type AsyncAnswer = {
  readonly call: string
  readonly part: number
  readonly question: string
  readonly answer: string
}

const parsed = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

const trimmed = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

// What a prompt answers, in its order, where it is Codex's reply to async questions. None
// for any other prompt, and for one whose JSON or items are not as probed.
const asyncAnswers = (prompt: string): readonly AsyncAnswer[] => {
  const body = asyncReply.exec(prompt)?.[1]
  const items = body === undefined ? undefined : parsed(body)
  if (!Array.isArray(items) || items.length === 0) return []
  const answers: AsyncAnswer[] = []
  for (const item of items) {
    const {
      questionItemId: raw,
      question,
      answer,
    } = (item ?? {}) as {
      questionItemId?: unknown
      question?: unknown
      answer?: unknown
    }
    const place = typeof raw === "string" ? parsed(raw) : undefined
    if (!Array.isArray(place) || place[0] !== asyncTool) return []
    if (typeof place[1] !== "string" || place[1] === "") return []
    if (!Number.isInteger(place[2]) || (place[2] as number) < 0) return []
    answers.push({
      call: place[1],
      part: place[2] as number,
      question: trimmed(question),
      answer: trimmed(answer),
    })
  }
  return answers
}

/**
 * The questions a prompt answers, each once, by its call's id and its place in the call,
 * where it is Codex's reply to async questions: one reply for each question answered.
 * None for any other prompt, and for one whose JSON or items are not as probed.
 */
export const asyncReplies = (
  prompt: string,
): readonly { readonly call: string; readonly part: number }[] => {
  const answered = new Map<string, { readonly call: string; readonly part: number }>()
  for (const { call, part } of asyncAnswers(prompt))
    answered.set(JSON.stringify([call, part]), { call, part })
  return [...answered.values()]
}

// What the chat says of an answer that holds no text.
const noAnswer = "(no answer)"

/**
 * Codex's reply to async questions as the person's words, the way its own history shows
 * them: `Re: ` and the question, then the answer, for each question it answers. Undefined
 * for any other prompt.
 */
export const asyncReplyText = (prompt: string): string | undefined => {
  const answers = asyncAnswers(prompt)
  if (answers.length === 0) return undefined
  return answers
    .map(({ question, answer }) => {
      const said = answer || noAnswer
      return question ? `Re: ${question}\n${said}` : said
    })
    .join("\n\n")
}

/**
 * What an async question's request asks about: its first question's title, and that
 * question's options, as the other question tools' requests give theirs (`subjectOf`
 * reads `question` and `label`, where this tool has `title` and plain strings); and each
 * question's title as a part, as each is answered on its own.
 */
export const asyncSubject = (
  input: unknown,
): {
  readonly subject: string | null
  readonly choices: readonly string[]
  readonly parts: readonly string[]
} => {
  const questions = (input as { questions?: unknown } | null)?.questions
  const listed: unknown[] = Array.isArray(questions) ? questions : []
  const [first] = listed
  const { title, options } = (first ?? {}) as { title?: unknown; options?: unknown }
  return {
    parts: listed.map((each) => {
      const named = (each as { title?: unknown } | null)?.title
      return typeof named === "string" ? named.trim() : ""
    }),
    subject: typeof title === "string" ? title.slice(0, 1024) : null,
    choices: (Array.isArray(options) ? options : [])
      .filter((option): option is string => typeof option === "string" && option.length > 0)
      .slice(0, 16)
      .map((option) => option.slice(0, 256)),
  }
}
