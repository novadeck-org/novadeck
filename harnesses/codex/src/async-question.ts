import { callId } from "@novadeck/harness-core/decode"

/**
 * The tool Codex offers to ask without waiting (0.162.1 on, to a model that lists it). It
 * returns `{"accepted":true}` at once and the turn runs on, so the request outlives the
 * turn, and the person's answer comes back as a prompt of Codex's own that names the call.
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
// JSON array of the tool, the call's id and the question's place (probed 2026-10-29).
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

/**
 * The questions a prompt answers, each once, by its call's id and its place in the call,
 * where it is Codex's reply to async questions: one reply for each question answered.
 * None for any other prompt, and for one whose JSON or items are not as probed.
 */
export const asyncReplies = (
  prompt: string,
): readonly { readonly call: string; readonly part: number }[] => {
  const body = asyncReply.exec(prompt)?.[1]
  if (body === undefined) return []
  let items: unknown
  try {
    items = JSON.parse(body)
  } catch {
    return []
  }
  if (!Array.isArray(items) || items.length === 0) return []
  const answered = new Map<string, { readonly call: string; readonly part: number }>()
  for (const item of items) {
    const raw = (item as { questionItemId?: unknown } | null)?.questionItemId
    if (typeof raw !== "string") return []
    let place: unknown
    try {
      place = JSON.parse(raw)
    } catch {
      return []
    }
    if (!Array.isArray(place) || place[0] !== asyncTool) return []
    if (typeof place[1] !== "string" || place[1] === "") return []
    if (!Number.isInteger(place[2]) || (place[2] as number) < 0) return []
    answered.set(JSON.stringify(place.slice(1, 3)), { call: place[1], part: place[2] as number })
  }
  return [...answered.values()]
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
