import { noticePrefix } from "@novadeck/protocol/notices"

/**
 * The one shape of every text Novadeck sends an agent of its own accord (see
 * docs/agent-messaging.md, "Notice format"): standing notices on the prompt, event notices
 * sent as messages, the hook's lines, and the rules of a delivery's wrapper.
 *
 *     Novadeck · <Kind>
 *     <what happened: facts first>
 *       <optional detail line, indented two spaces>
 *     → <what to do, one line per action>
 *
 * Every such text is built here, so none writes its header by hand. The doorbell lines
 * (harnesses/core/src/prompts.ts) are no notices and keep their own form.
 */

/**
 * The kinds a notice has, each a header's second half. A kind is a family, named for what the
 * notice is about rather than for the code that sends it, so a new source of the same sort of
 * news joins its family: another shared resource under `Resources`, another shown item's
 * problems under `Show`.
 */
export const noticeKinds = [
  "Describe",
  "Show",
  "Inbox",
  "Inbox answers",
  "Worktrees",
  "Restart",
  "Resources",
  "Messages",
  "Notices",
  "Terminals",
  "Team",
  "Shipping",
] as const

export type NoticeKind = (typeof noticeKinds)[number]

/** What starts every notice's first line, up to its kind: one rule with whoever reads a notice. */
export { noticePrefix }

/** What a notice says: its facts, detail lines under them, and one line per action. */
export type NoticeParts = {
  readonly facts: string
  /** Lines under the facts, as a path or a list; each is indented. */
  readonly details?: readonly string[]
  /** What the agent is to do, one line each; none where there is nothing to do. */
  readonly actions?: readonly string[]
}

/** A notice's header line. */
export const noticeHeader = (kind: NoticeKind): string => `${noticePrefix}${kind}`

/** The lines of a notice's body: facts, then its details and actions. */
export const noticeLines = ({ facts, details = [], actions = [] }: NoticeParts): string[] => [
  facts,
  ...details.map((line) => `  ${line}`),
  ...actions.map((line) => `→ ${line}`),
]

/** A notice of `kind`: its header, its facts, its detail lines, and an action line each. */
export const noticeText = (kind: NoticeKind, parts: NoticeParts): string =>
  [noticeHeader(kind), ...noticeLines(parts)].join("\n")
