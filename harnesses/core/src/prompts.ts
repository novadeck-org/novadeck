import type { EventBase, HarnessEvent } from "./events.js"

/**
 * The prompts a session sees that aren't the person's own: Novadeck's doorbell line and
 * a hook's continuation; and the turn a root prompt starts, told apart by them.
 */

// The doorbell line's words, and a pattern of the whole line that captures its nonce.
const notice = "Novadeck: automatic notice, agent messages waiting"
const pattern = String.raw`\[${notice}, ([A-Za-z0-9]+)\]`

/** The line Novadeck's doorbell types, with its nonce (see docs/agent-messaging.md). */
export const doorbellLine = (nonce: string): string => `[${notice}, ${nonce}]`

/** Any doorbell line, wherever it is. */
export const doorbell = new RegExp(pattern, "g")

const doorbellOnly = new RegExp(`^${pattern}$`)

// The reply line's head, and a pattern of the whole line: its nonce opens and closes it, so
// a line left in the box is told apart from text typed after it.
const replyHead = "Novadeck Inbox reply"
const replyPattern = String.raw`\[${replyHead}, ([A-Za-z0-9]+)\] [^\n]*? \[\1\]`

/** Any reply line, wherever it is. */
export const replyDoorbell = new RegExp(replyPattern, "g")

const replyOnly = new RegExp(`^${replyPattern}$`)

/**
 * The person's reply to an agent's Inbox ask, as the reply line names it: the ask's
 * subject, the option they picked or the action they marked done (all three the agent's
 * words), and their own words.
 */
export type InboxReply = {
  readonly subject: string
  readonly option?: string
  readonly action?: string
  readonly text: string
}

/** The longest a reply line runs, so no harness folds it into a pasted-text placeholder. */
export const maxReplyLine = 320

// The longest the agent's words of a reply run in the line: its subject, and the option or
// action label.
const agentLimits = { subject: 80, choice: 40 } as const

// The fewest characters of the person's words worth a line; with less room, the plain line.
const minWords = 24

// What a line drops: control characters (C0 and C1) as a space, and, as nothing, what a
// terminal may draw otherwise than it was given, so the paste check never finds it (emoji,
// their joiners and selectors) or draws as nothing (zero-width and direction marks).
// eslint-disable-next-line no-control-regex -- Control characters are what it drops.
const controls = /[\u0000-\u001f\u007f-\u009f]+/g
const unseen = new RegExp(
  String.raw`\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufe00-\ufe0f\ufeff]`,
  "gu",
)

/**
 * Text as one line that no harness treats specially and no one can read as the line's own
 * frame: control characters a space, whitespace runs one space, `@` and `$` (Claude Code
 * attaches an `@path`, Codex opens a picker on either) full-width, and brackets as
 * parentheses, so no text shows a line's head or closing nonce.
 */
const inline = (text: string): string =>
  text
    .replace(controls, " ")
    .replace(unseen, "")
    .replace(/\s+/g, " ")
    .replaceAll("@", "＠")
    .replaceAll("$", "＄")
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .trim()

/**
 * The agent's words, as `inline`, which the line quotes: never a double quote or `|`, so
 * they can't close the quote or start another reply, and read as the person's choice.
 */
const quoted = (text: string, limit: number): string =>
  `"${cut(inline(text).replaceAll('"', "'").replaceAll("|", "/"), limit)}"`

/** Text cut to `limit` characters (whole code points), an ellipsis ending what was cut. */
const cut = (text: string, limit: number): string => {
  const points = [...text]
  return points.length > limit
    ? `${points
        .slice(0, limit - 3)
        .join("")
        .trimEnd()}...`
    : text
}

/**
 * One reply as the line says it, in the person's voice, their words cut to `words`
 * characters: the agent's subject and labels quoted as its own.
 */
const replyPhrase = ({ subject, option, action, text }: InboxReply, words: number): string => {
  const asked = `Re your ask ${quoted(subject, agentLimits.subject)}:`
  const own = cut(inline(text), words)
  if (action !== undefined)
    return `${asked} I marked it done (${quoted(action, agentLimits.choice)}).`
  if (option !== undefined)
    return own
      ? `${asked} I picked ${quoted(option, agentLimits.choice)} and wrote: ${own}`
      : `${asked} I picked ${quoted(option, agentLimits.choice)}.`
  return `${asked} ${own}`
}

/**
 * The line the doorbell types when the person's Inbox replies wait for the agent: every
 * one of them, in their voice, so the agent's harness takes them as the person's own
 * prompt (as Claude Code's auto mode does an approval); the delivery the prompt's hook
 * gives then carries them in full, with any agents' messages. Its nonce opens and closes
 * it. Within `maxReplyLine`, the person's words in each are cut to fit, an ellipsis
 * showing it; undefined for no replies, or for more than fit with `minWords` of each,
 * which then come with the plain line's delivery alone: never some of them, as a later
 * one may take back an earlier.
 */
export const replyLine = (
  replies: readonly InboxReply[],
): ((nonce: string) => string) | undefined => {
  if (replies.length === 0) return undefined
  const frame = (nonce: string, words: number) =>
    `[${replyHead}, ${nonce}] ${replies.map((reply) => replyPhrase(reply, words)).join(" | ")} [${nonce}]`
  // The person's words go uncut where they fit, else as long as they all fit.
  const longest = Math.max(...replies.map(({ text }) => [...inline(text)].length))
  const room = (nonce: string): number | undefined => {
    for (let words = Math.min(longest, maxReplyLine); words >= minWords; words -= 1)
      if ([...frame(nonce, words)].length <= maxReplyLine) return words
    return longest < minWords && [...frame(nonce, longest)].length <= maxReplyLine
      ? longest
      : undefined
  }
  // Whether they fit is told once, by a nonce as long as the typist's.
  if (room("x".repeat(nonceLength)) === undefined) return undefined
  return (nonce) => frame(nonce, room(nonce) ?? minWords)
}

/** The length of the typist's nonces (`freshNonce` in `@novadeck/tui-input`). */
const nonceLength = 6

/**
 * The nonce of a prompt that is exactly a doorbell line or a reply line, as typed or
 * started with; else undefined.
 */
export const doorbellNonce = (prompt: string): string | undefined => {
  const trimmed = prompt.trim()
  return doorbellOnly.exec(trimmed)?.[1] ?? replyOnly.exec(trimmed)?.[1]
}

/**
 * The person's prompt without any doorbell or reply line left in it, as a line a failed
 * ring left in the box that they then submitted with their own text.
 */
export const withoutDoorbell = (prompt: string): string =>
  prompt
    .replace(doorbell, "")
    .replace(replyDoorbell, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()

/**
 * The characters a quoted line may hold: none that sh, zsh, fish, PowerShell or cmd expand
 * or end a double-quoted word at (`$`, a backtick, `\\`, `"`, `!`, `%`, `^`, `&`, `;`, a
 * newline), so one quoting works in all of them.
 */
const quotable = /^[A-Za-z0-9 ,.:/_[\]=@+-]*$/

/**
 * Quotes a line for any shell Novadeck starts as one word. It refuses (throws) a line
 * holding a character a shell might expand, rather than trusting the quotes to hold it.
 */
export const quotedLine = (line: string): string => {
  if (!quotable.test(line))
    throw new RangeError("The line holds a character no shell quotes safely.")
  return `"${line}"`
}

/**
 * Whether a prompt is a delivery of agents' messages rather than the person's, in any
 * harness. A harness's own continuations it tells itself (see `promptStart`), and a doorbell
 * prompt is told apart by `doorbellNonce`.
 */
export const continuationPrompt = (prompt: string): boolean => prompt.includes("<novadeck-messages")

/**
 * The turn a root prompt starts, from its text: Novadeck's doorbell, a delivery (or
 * `harness` by the harness's own reckoning, as a Stop hook's reason it submits as a prompt),
 * or a prompt with the person's text, any doorbell line removed.
 */
export const promptStart = (
  base: EventBase & {
    /** The turn's id, where the harness names one. */
    readonly turn?: string
  },
  prompt: string,
  harness = false,
): HarnessEvent => {
  const nonce = doorbellNonce(prompt)
  if (nonce)
    return {
      type: "turn-started",
      ...base,
      cause: "doorbell",
      nonce,
      ...(replyOnly.test(prompt.trim()) && { replies: true as const }),
    }
  if (harness || continuationPrompt(prompt))
    return { type: "turn-started", ...base, cause: "harness" }
  const own = withoutDoorbell(prompt)
  return { type: "turn-started", ...base, cause: "prompt", ...(own && { prompt: own }) }
}
