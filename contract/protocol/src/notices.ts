/**
 * How Novadeck's own notices read, data only (no schema, no dependency), so the runner's
 * decoders, the chat and a terminal overlay all take a notice apart by one rule. A notice is
 * built by the runner's `notice-format.ts`:
 *
 *     Novadeck · <Kind>
 *     <what happened: facts first>
 *       <optional detail line, indented two spaces>
 *     → <what to do, one line per action>
 *
 * The person sees a notice's own words, never its header: `readNotice` strips it, and
 * splits the facts from the `→` actions.
 */

/** What starts every notice's first line, up to its kind. */
export const noticePrefix = "Novadeck · "

// The header notices had before they shared one shape: one run-on sentence behind this. A
// transcript written by an earlier build holds them, and reads the same way.
const legacyPrefix = "Novadeck: automatic notice, not from the user: "

/** What a notice says, taken apart: its kind (null for one with no header) and its lines. */
export type ReadNotice = {
  /** The header's second half ("Worktrees", "Inbox"), null where the text has no header. */
  readonly kind: string | null
  /** The facts and the detail lines under them, as written (a detail keeps its indent). */
  readonly facts: readonly string[]
  /** What the agent is to do, each without its arrow. */
  readonly actions: readonly string[]
}

const arrow = "→ "

/** Takes a notice's text apart: header off, facts and detail lines, then the action lines. */
export const readNotice = (text: string): ReadNotice => {
  const lines = text.replace(/\r\n?/g, "\n").trim().split("\n")
  const [first = ""] = lines
  let kind: string | null = null
  let rest = lines
  if (first.startsWith(noticePrefix)) {
    kind = first.slice(noticePrefix.length).trim() || null
    rest = lines.slice(1)
  } else if (first.startsWith(legacyPrefix)) {
    rest = [first.slice(legacyPrefix.length), ...lines.slice(1)]
  }
  const facts: string[] = []
  const actions: string[] = []
  for (const line of rest.map((each) => each.trimEnd())) {
    if (line.startsWith(arrow)) actions.push(line.slice(arrow.length))
    else facts.push(line)
  }
  return { kind, facts, actions }
}

/** The notice as one line for a collapsed view: its facts, then each action after an arrow. */
export const noticeOneLine = (text: string): string => {
  const { facts, actions } = readNotice(text)
  return [...facts, ...actions.map((action) => `${arrow}${action}`)]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

/** The notice's own words without its header, a line each, its actions behind their arrows. */
export const noticeBody = (text: string): string => {
  const { facts, actions } = readNotice(text)
  return [...facts, ...actions.map((action) => `${arrow}${action}`)].join("\n")
}

const headerLine = /^(?:Novadeck · |Novadeck: automatic notice, not from the user: )/m

// A hook's text may lead with the phrase Claude Code puts before a Stop's reason.
const stopLead = /^\s*Stop hook (?:feedback|says):\s*/

/**
 * What one hook printed, split: the notices in it (each as `readNotice` reads it) and
 * whether it holds a delivery of agents' messages (`<novadeck-messages>`, the ring's own,
 * read apart). A hook joins its notices, and a delivery, with a blank line. Text that
 * is neither starts with neither, and is no Novadeck's: no notices are read from it.
 */
export const splitHookText = (
  text: string,
): { readonly notices: readonly string[]; readonly delivery: boolean } => {
  const start = text.indexOf("<novadeck-messages")
  const close = "</novadeck-messages>"
  const end = text.lastIndexOf(close)
  const delivery = start !== -1
  const rest = delivery
    ? `${text.slice(0, start).replace(stopLead, "")}\n\n${end === -1 ? "" : text.slice(end + close.length)}`
    : text
  const body = rest.trim()
  if (!headerLine.test(body.split("\n")[0] ?? "")) return { notices: [], delivery }
  const notices: string[] = []
  let current: string[] = []
  for (const line of body.split("\n")) {
    if (headerLine.test(line) && current.length > 0) {
      notices.push(current.join("\n").trim())
      current = []
    }
    current.push(line)
  }
  notices.push(current.join("\n").trim())
  return { notices, delivery }
}
