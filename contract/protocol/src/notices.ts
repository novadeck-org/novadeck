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
 * `readNotice` strips the header and splits the facts from the `→` actions. What the person
 * sees of a notice is `noticeSeen`'s line (`noticesSeen`'s, for several delivered together), never
 * its facts.
 */

/** What starts every notice's first line, up to its kind. */
export const noticePrefix = "Novadeck · "

/**
 * How the facts of the two notices that share a kind with a standing one, and ride the same
 * hook, start: a shown page's problems (Show) and worktrees turned off (Worktrees). The runner
 * writes them with these, and the person's line tells them apart by them.
 */
export const pageTroubleLead = "The page you showed"
export const worktreesOffLead = "Agent worktrees are off"

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

// What the person is told of an event notice, by the family of its kind: a short line in a
// game log's voice, the agent's. "You" is only the agent noticing it, and the rest names things
// plainly (the terminal, an ask, the user, never "your" or "you" again), so the person reading it
// never takes it as about them. The kinds earlier builds wrote (Host load, CI queue, Page, Lead,
// Move, Close, Run) are in transcripts a resumed session holds, and map to their family's line.
const seen: Readonly<Record<string, string>> = {
  Restart: "You notice Novadeck restarted.",
  Terminals: "You notice terminals open and close.",
  Team: "You notice news about the team.",
  Worktrees: "You notice news about a worktree.",
  Inbox: "You notice an ask leave the Inbox.",
  "Inbox answers": "You notice answers from the Inbox.",
  Resources: "You notice shared resources are busy.",
  Show: "You notice problems in a shown page.",
  Shipping: "You notice news about a permit.",
  Messages: "You notice a message still on its way.",
  Notices: "You notice a note from Novadeck.",
  Describe: "You notice the terminal needs a title.",
}
const seenOldKinds: Readonly<Record<string, string>> = {
  "Host load": "Resources",
  "CI queue": "Resources",
  Page: "Show",
  Lead: "Team",
  Move: "Team",
  Close: "Terminals",
  Run: "Terminals",
}
// What the person is told of a notice that rode on the prompt's hook, by its kind: a standing one
// that says how a part of Novadeck works here (what it is about, not what happened), or the hook's
// own line on how the prompt's messages came (`Messages`), which says something either way.
const seenStanding: Readonly<Record<string, string>> = {
  Describe: "You notice the terminal needs a title.",
  Inbox: "You notice questions go to the Inbox too.",
  Show: "You notice where to show work.",
  Worktrees: "You notice agent worktrees are on.",
  Messages: "You notice Novadeck check for messages.",
}
// The standing notices that say how a part of Novadeck works, which a session's first prompt
// carries together.
const setUpKinds = new Set(["Describe", "Inbox", "Show", "Worktrees"])
const seenUnknown = "You notice something."
// A message from Novadeck with no header is a brief it hands the agent, such as the tour's task.
const seenBrief = "You notice Novadeck hand over a task."
// Several standing notices at once, as a session's first prompt carries them.
const seenSetUp = "You notice a briefing from Novadeck."
const seenWorktreesOff = "You notice agent worktrees are off."

// What a notice on the prompt's hook is: how a part of Novadeck works (its kind), worktrees
// turned off, or news that rides the hook too (a shown page's problems), which says its family's
// event line.
const standingAbout = (kind: string, facts: readonly string[]): string | null => {
  const first = facts[0] ?? ""
  if (kind === "Show" && first.startsWith(pageTroubleLead)) return null
  if (kind === "Worktrees" && first.startsWith(worktreesOffLead)) return "Worktrees off"
  return kind
}

/**
 * The one line the person is told of a notice: its family's, for an event; for a `standing` one
 * (it rode on the prompt's hook), what it is about. A brief from Novadeck, with no header, says it
 * handed over a task.
 */
export const noticeSeen = (text: string, { standing = false } = {}): string => {
  const { kind, facts } = readNotice(text)
  if (kind === null) return text.trimStart().startsWith(legacyPrefix) ? seenUnknown : seenBrief
  const family = seenOldKinds[kind] ?? kind
  const about = standing ? standingAbout(family, facts) : null
  if (about === "Worktrees off") return seenWorktreesOff
  return (about === null ? undefined : seenStanding[about]) ?? seen[family] ?? seenUnknown
}

/**
 * The one line the person is told of notices delivered together (a ring's, or a prompt's hook's):
 * each one's line once, in order, joined by ` · `, and where more than one is a standing notice of
 * how Novadeck works (the bar, the Inbox, the title, worktrees on), those as a briefing from
 * Novadeck.
 */
export const noticesSeen = (
  notices: readonly { readonly text: string; readonly standing?: boolean }[],
): string => {
  const setUp = notices.filter(({ text, standing }) => {
    const { kind, facts } = readNotice(text)
    return standing === true && setUpKinds.has(standingAbout(kind ?? "", facts) ?? "")
  })
  const lines = notices.flatMap((notice) =>
    setUp.length > 1 && setUp.includes(notice)
      ? notice === setUp[0]
        ? [seenSetUp]
        : []
      : [noticeSeen(notice.text, { standing: notice.standing === true })],
  )
  return [...new Set(lines)].join(" · ")
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
