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

const open = "<novadeck-messages"
const close = "</novadeck-messages>"

// Where a delivery that starts at `start` ends: after its closing tag; where the text was cut
// short and has none, at the next notice's header after a blank line, else the text's end.
const deliveryEnd = (text: string, start: number): number => {
  const end = text.indexOf(close, start)
  if (end !== -1) return end + close.length
  const next = new RegExp(String.raw`\n[ \t]*\n(?=${noticePrefix}|${legacyPrefix})`).exec(
    text.slice(start),
  )
  return next ? start + next.index : text.length
}

// The notices a stretch of text between deliveries holds: it must start with one, after the Stop
// phrase Claude Code puts before a Stop's reason.
const noticesIn = (chunk: string): string[] => {
  const body = chunk.replace(stopLead, "").trim()
  if (!headerLine.test(body.split("\n")[0] ?? "")) return []
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
  return notices
}

/**
 * What one hook printed, split: the notices in it (each as `readNotice` reads it) and
 * whether it holds a delivery of agents' messages (`<novadeck-messages>`), the ring's own,
 * read apart. A hook joins its notices, and a delivery, with a blank line. Every stretch outside a
 * delivery is read on its own, so notices before, between and after deliveries all count, and so
 * does a Stop's text with no delivery. A stretch that doesn't start with a notice is no Novadeck's.
 */
export const splitHookText = (
  text: string,
): { readonly notices: readonly string[]; readonly delivery: boolean } => {
  const notices: string[] = []
  let delivery = false
  let from = 0
  for (let start = text.indexOf(open); start !== -1; start = text.indexOf(open, from)) {
    delivery = true
    notices.push(...noticesIn(text.slice(from, start)))
    from = deliveryEnd(text, start)
  }
  notices.push(...noticesIn(text.slice(from)))
  return { notices, delivery }
}
