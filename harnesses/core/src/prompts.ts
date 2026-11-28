import { isDelivery } from "@novadeck/protocol/harnesses"

import type { EventBase, HarnessEvent } from "./events.js"

/**
 * The prompts a session sees that aren't the person's own: Novadeck's doorbell line and
 * a hook's continuation; and the turn a root prompt starts, told apart by them.
 */

// The doorbell line is one self-closing tag: `from` holds the waiting messages' senders' bare
// handles (`novadeck` for Novadeck's own notices), a few and then a count, and `ring`, the
// nonce, comes last, so a box too short for the line still shows it at the end. A task's start
// prompt (`startLine`) quotes its attributes with `'`, so a shell's double quotes can hold it.
// Readers also take `ring` first, and the old bracket line of sessions from before the tag
// (`oldPattern`), which transcripts of existing and resumed sessions hold.
const fromClass = String.raw`[A-Za-z0-9_ +-]*`
const tagPatterns = [
  String.raw`<novadeck-doorbell from=["']${fromClass}["'] ring=["']([A-Za-z0-9]+)["']/>`,
  String.raw`<novadeck-doorbell ring=["']([A-Za-z0-9]+)["'] from=["']${fromClass}["']/>`,
]
const oldPattern = String.raw`\[Novadeck: automatic notice, agent messages waiting, ([A-Za-z0-9]+)\]`

/** How many senders' handles a line names before it counts the rest. */
export const namedSenders = 3

/**
 * The senders' handles a line names: bare, in delivery order, each once (anything else is
 * dropped), the first few and then `+N` for the N others. `novadeck` stays among those named,
 * in place of the last, where notices wait.
 */
const handlesOf = (from: readonly string[]): string => {
  const all = [...new Set(from.filter((handle) => /^[A-Za-z0-9_-]+$/.test(handle)))]
  if (all.length <= namedSenders) return all.join(" ")
  const named = all.slice(0, namedSenders)
  if (all.includes("novadeck") && !named.includes("novadeck")) named[namedSenders - 1] = "novadeck"
  return `${named.join(" ")} +${all.length - namedSenders}`
}

/**
 * The line Novadeck's doorbell types, with the bare handles of the senders of the messages
 * waiting, in delivery order, and its nonce last (see dev-docs/agent-messaging.md).
 */
export const doorbellLine = (nonce: string, from: readonly string[] = []): string =>
  `<novadeck-doorbell from="${handlesOf(from)}" ring="${nonce}"/>`

/**
 * The doorbell line a task's start prompt is: the same tag with `'` for its quotes, so a
 * command line can hold it in double quotes in every shell (`quotedLine`).
 */
export const startLine = (nonce: string): string => `<novadeck-doorbell from='' ring='${nonce}'/>`

// The reply line is the person's Inbox replies as typed prompt text in one element, then a
// tag naming its ring: so a line left in the box is told apart from text typed after it, and
// a box showing only its end still names the ring. Words hold no `<`, so none can close the
// element or fake the end tag.
const replyPattern = String.raw`<novadeck-reply>[^\n<]*</novadeck-reply><end ring="([A-Za-z0-9]+)"/>`
const oldReplyPattern = String.raw`\[Novadeck Inbox reply, ([A-Za-z0-9]+)\] [^\n]*? \[\1\]`

// A whole prompt that is a line of a form, its nonce captured.
const bellForms = [...tagPatterns, oldPattern].map((source) => new RegExp(`^${source}$`))
const replyForms = [replyPattern, oldReplyPattern].map((source) => new RegExp(`^${source}$`))

// The same forms as a box reader gives a line wrapped over rows, whitespace compacted away.
const compactForms = [...tagPatterns, oldPattern, replyPattern, oldReplyPattern].map(
  (source) => new RegExp(`^${source.replaceAll(" ", "")}$`),
)

/** Any doorbell line, of any form, wherever it is. */
export const doorbell = new RegExp([...tagPatterns, oldPattern].join("|"), "g")

/** Any reply line, of either form, wherever it is (a backreference per form). */
export const replyDoorbell = new RegExp(
  `${replyPattern}|${oldReplyPattern.replaceAll("\\1", "\\2")}`,
  "g",
)

/**
 * The person's reply to an agent's Inbox ask, as the reply line names it: the ask's
 * subject, the option they picked or the action they marked done (all three the agent's
 * words), and their own words.
 */
export type InboxReply = {
  readonly subject: string
  readonly option?: string
  readonly action?: string
  /** A questions ask's answers: each question (its header where it has one), the labels picked, and the words written. */
  readonly answers?: readonly {
    readonly question: string
    readonly picked: readonly string[]
    readonly text: string
  }[]
  readonly text: string
}

/** The longest a reply line runs, so no harness folds it into a pasted-text placeholder. */
export const maxReplyLine = 320

// The longest the agent's words of a reply run in the line: its subject, and the option or
// action label.
const agentLimits = { subject: 80, choice: 40 } as const

// What no line holds: anything a terminal may draw otherwise than it was given, so the
// paste check never finds it (emoji, their joiners, modifiers and selectors, a keycap), or
// draws as nothing (format characters: zero-width, direction marks, tags, a soft hyphen),
// unassigned or private characters, half a surrogate pair, and control characters other
// than whitespace. Dropping them could change the person's words (an emoji may be the
// answer), so replies holding any ring with the plain line instead.
const unfit = new RegExp(
  String.raw`[\p{Cf}\p{Co}\p{Cn}\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f⃣︀-️\u{e0100}-\u{e01ef}]|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}`,
  "u",
)

/**
 * Text as one line that no harness treats specially and no one can read as the line's own
 * frame: whitespace runs one space; `@` and `$` (Claude Code attaches an `@path`, Codex
 * opens a picker on either), `&`, `<` and `>` full-width, so the text opens or closes no tag
 * and keeps its meaning (`a ＞ b`); and brackets as parentheses, so no text shows an old line's
 * head or closing nonce.
 */
const inline = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .replaceAll("@", "＠")
    .replaceAll("$", "＄")
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .replaceAll("<", "＜")
    .replaceAll(">", "＞")
    .replaceAll("&", "＆")
    .trim()

/**
 * The agent's words, as `inline`, which the line quotes and cuts to `limit`: never a double
 * quote or `|`, nor one that looks like it, so they can't close the quote or start another
 * reply, and read as the person's choice.
 */
const quoted = (text: string, limit: number): string =>
  `"${cut(
    inline(text)
      .replace(/["“”„‟″‶＂]/g, "'")
      .replace(/[|¦∣｜]/g, "/"),
    limit,
  )}"`

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
 * One reply as the line says it, in the person's voice, their words whole: the agent's
 * subject and labels quoted as its own.
 */
const replyPhrase = ({ subject, option, action, answers, text }: InboxReply): string => {
  const asked = `Re your ask ${quoted(subject, agentLimits.subject)}:`
  const own = inline(text)
  if (answers !== undefined) return `${asked} ${answers.map(answerPhrase).join(" ")}`
  if (action !== undefined)
    return `${asked} I marked it done (${quoted(action, agentLimits.choice)}).`
  if (option !== undefined)
    return own
      ? `${asked} I picked ${quoted(option, agentLimits.choice)} and wrote: ${own}`
      : `${asked} I picked ${quoted(option, agentLimits.choice)}.`
  return `${asked} ${own}`
}

/** One question's answer as the reply line says it: what was picked, and what was written. */
const answerPhrase = ({
  question,
  picked,
  text,
}: NonNullable<InboxReply["answers"]>[number]): string => {
  const own = inline(text)
  const chose = picked.map((label) => quoted(label, agentLimits.choice)).join(" and ")
  const said = [chose && `I picked ${chose}`, own && `I wrote: ${own}`]
    .filter(Boolean)
    .join(" and ")
  return `For ${quoted(question, agentLimits.choice)}, ${said}.`
}

/**
 * The line the doorbell types when the person's Inbox replies wait for the agent: every
 * one of them, in their voice and their words whole, so the agent's harness takes them as
 * the person's own prompt (as Claude Code's auto mode does an approval); the delivery the
 * prompt's hook gives then carries them in full, with any agents' messages. Its nonce opens
 * it and closes it (the tag after its element). Only the agent's subject and labels are cut. Undefined for no replies,
 * for replies that don't all fit `maxReplyLine` whole, and for any holding what no line
 * holds (`unfit`): those come with the plain line's delivery alone, never some or part of
 * them, as a later one may take back an earlier, or the words cut a condition off.
 */
export const replyLine = (
  replies: readonly InboxReply[],
): ((nonce: string) => string) | undefined => {
  if (replies.length === 0) return undefined
  const fields = replies.flatMap(({ subject, option, action, answers, text }) => [
    subject,
    option ?? "",
    action ?? "",
    ...(answers ?? []).flatMap((each) => [each.question, ...each.picked, each.text]),
    text,
  ])
  if (fields.some((field) => unfit.test(field))) return undefined
  const body = replies.map(replyPhrase).join(" | ")
  const line = (nonce: string) => `<novadeck-reply>${body}</novadeck-reply><end ring="${nonce}"/>`
  // Whether they fit is told by a nonce as long as the typist's (`freshNonce`).
  if ([...line("x".repeat(nonceLength))].length > maxReplyLine) return undefined
  return line
}

/** The length of the typist's nonces (`freshNonce` in `@novadeck/tui-input`). */
const nonceLength = 6

/**
 * The nonce of a prompt that is exactly a doorbell line or a reply line, as typed or
 * started with; else undefined.
 */
export const doorbellNonce = (prompt: string): string | undefined => {
  const trimmed = prompt.trim()
  return [...bellForms, ...replyForms].map((form) => form.exec(trimmed)?.[1]).find(Boolean)
}

const replyOnly = (prompt: string): boolean => replyForms.some((form) => form.test(prompt.trim()))

/**
 * What a prompt that is exactly a doorbell line or a reply line says of its ring: its nonce, and
 * whether it carries the person's Inbox replies; null for any other prompt. A person's words
 * with a line stuck in them are theirs.
 */
export const ringOf = (
  prompt: string,
): { readonly nonce: string; readonly replies: boolean } | null => {
  const nonce = doorbellNonce(prompt)
  return nonce === undefined ? null : { nonce, replies: replyOnly(prompt) }
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

// The most rows a wrapped line is looked for over (a reply line at a narrow width).
const maxRows = 32

/**
 * Words given back from the box without the doorbell and reply lines among them: a line of
 * Novadeck's that was queued comes back with the person's, and isn't theirs to get.
 */
export const withoutDoorbellLines = (words: string): string => {
  const kept: string[] = []
  const lines = words.split("\n")
  for (let at = 0; at < lines.length;) {
    // A box wraps a long line over rows, which come back as lines, some broken at a space and
    // some inside a word: the rows read together with their whitespace compacted away, as
    // the box's own leftover is (`compact`).
    let span: number | undefined
    for (let count = 1; count <= maxRows && at + count <= lines.length; count += 1) {
      const text = lines
        .slice(at, at + count)
        .join("")
        .replace(/\s+/g, "")
      if (compactForms.some((form) => form.test(text))) {
        span = count
        break
      }
    }
    if (span === undefined) kept.push(lines[at]!)
    at += span ?? 1
  }
  return kept.join("\n").trim()
}

/**
 * The characters a quoted line may hold: none that sh, zsh, fish, PowerShell or cmd expand
 * or end a double-quoted word at (`$`, a backtick, `\\`, `"`, `!`, `%`, `^`, `&`, `;`, a
 * newline), so one quoting works in all of them. `<`, `>` and `'` are literal inside double
 * quotes in every one of them (cmd's redirections end at its quotes), which is why a start
 * prompt's tag quotes its attributes with `'` (`startLine`): a `"` has no such quoting.
 */
const quotable = /^[A-Za-z0-9 ,.:/_[\]=@+<>'-]*$/

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
 * A command line for the words, as Novadeck starts an agent with: every word but a quoted
 * line is a plain word, and a line holds nothing a shell expands. A line that holds such a
 * character throws a `RangeError` (`quotedLine`).
 */
export const commandLine = (argv: readonly string[]): string =>
  argv.map((word) => (/^[\w./-]+$/.test(word) ? word : quotedLine(word))).join(" ")

/**
 * Whether a prompt is a delivery of agents' messages rather than the person's, in any
 * harness, by the one rule the chat and the Inbox read too (`isDelivery`): one that starts
 * with a delivery, never the person's words that quote one. A harness's own continuations
 * it tells itself (see `promptStart`), and a doorbell prompt is told apart by `doorbellNonce`.
 */
export const continuationPrompt = (prompt: string): boolean => isDelivery(prompt)

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
      ...(replyOnly(prompt) && { replies: true as const }),
    }
  if (harness || continuationPrompt(prompt))
    return { type: "turn-started", ...base, cause: "harness" }
  const own = withoutDoorbell(prompt)
  return {
    type: "turn-started",
    ...base,
    cause: "prompt",
    ...(own && { prompt: own }),
  }
}
