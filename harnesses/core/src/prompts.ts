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
 * subject, the option they picked or the action they marked done, and their own words.
 */
export type InboxReply = {
  readonly subject: string
  readonly option?: string
  readonly action?: string
  readonly text: string
}

/** The longest a reply line runs, so no harness folds it into a pasted-text placeholder. */
export const maxReplyLine = 320

// The longest each part of a reply runs in the line.
const replyLimits = { subject: 80, choice: 40, text: 90 } as const

/**
 * A reply's text as one line that no harness treats specially: whitespace runs as one
 * space, no control characters, and `@` and `$` (Claude Code attaches an `@path`, Codex
 * opens a picker on either) as their full-width forms; cut to `limit` with an ellipsis.
 */
const inline = (text: string, limit: number): string => {
  const flat = text
    // eslint-disable-next-line no-control-regex -- Control characters are what it drops.
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .replaceAll("@", "＠")
    .replaceAll("$", "＄")
    .trim()
  return flat.length > limit ? `${flat.slice(0, limit - 3).trimEnd()}...` : flat
}

/** One reply as the line says it, in the person's voice. */
const replyPhrase = ({ subject, option, action, text }: InboxReply): string => {
  const asked = `Re "${inline(subject, replyLimits.subject)}":`
  const words = inline(text, replyLimits.text)
  if (action !== undefined)
    return `${asked} I marked it done ("${inline(action, replyLimits.choice)}").`
  if (option !== undefined)
    return words
      ? `${asked} I picked "${inline(option, replyLimits.choice)}" and wrote: ${words}`
      : `${asked} I picked "${inline(option, replyLimits.choice)}".`
  return `${asked} ${words}`
}

/**
 * The line the doorbell types when the person's Inbox replies wait for the agent: the
 * replies themselves, in their voice, so the agent's harness takes them as the person's own
 * prompt (as Claude Code's auto mode does an approval); the delivery the prompt's hook
 * gives then carries them in full, with any agents' messages. Its nonce opens and closes
 * it. Undefined for no replies. Replies that would run it past `maxReplyLine` are left to
 * the delivery alone, and the line says how many; the first is always in it.
 */
export const replyLine = (
  replies: readonly InboxReply[],
): ((nonce: string) => string) | undefined => {
  if (replies.length === 0) return undefined
  const phrases = replies.map(replyPhrase)
  return (nonce) => {
    const frame = (body: string) => `[${replyHead}, ${nonce}] ${body} [${nonce}]`
    let shown = 1
    while (
      shown < phrases.length &&
      frame(phrases.slice(0, shown + 1).join(" | ") + more(phrases.length - shown - 1)).length <=
        maxReplyLine
    )
      shown += 1
    return frame(phrases.slice(0, shown).join(" | ") + more(phrases.length - shown))
  }
}

const more = (left: number): string =>
  left > 0 ? ` | +${left} more ${left === 1 ? "reply" : "replies"} below` : ""

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
  if (nonce) return { type: "turn-started", ...base, cause: "doorbell", nonce }
  if (harness || continuationPrompt(prompt))
    return { type: "turn-started", ...base, cause: "harness" }
  const own = withoutDoorbell(prompt)
  return { type: "turn-started", ...base, cause: "prompt", ...(own && { prompt: own }) }
}
