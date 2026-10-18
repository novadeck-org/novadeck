import type { ChatDialog, ChatDialogOption, ChatRequest } from "#core/conversation"
import { harnesses, type AgentName } from "#core/harnesses"
import { inboxType, type InboxItem, type Trouble } from "#core/inbox"

// What the Inbox says about an item, in words: pure, so the rows and the sheet read the
// same sentences, and so their rules read apart from the markup.

const minute = 60_000
const hour = 60 * minute

// The harness as a short word in a sentence.
export const agentName = (agent: AgentName): string =>
  harnesses.find((each) => each.id === agent)?.shortName ?? agent

// How long ago, as a row's right edge says it: "now", "7m", "1h 12m", "2d".
export const waitLabel = (at: number, now: number): string => {
  const elapsed = Math.max(0, now - at)
  if (elapsed < minute) return "now"
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`
  if (elapsed < 24 * hour) {
    const minutes = Math.floor((elapsed % hour) / minute)
    return minutes === 0
      ? `${Math.floor(elapsed / hour)}h`
      : `${Math.floor(elapsed / hour)}h ${minutes}m`
  }
  return `${Math.floor(elapsed / (24 * hour))}d`
}

// A time of day, as `HH:MM` on the person's clock.
export const clock = (at: number): string => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

// The text between backticks as code, the rest as it is. An unpaired backtick is text.
export type TextPart = { readonly code: boolean; readonly text: string }
export const codeParts = (text: string): readonly TextPart[] => {
  const parts: TextPart[] = []
  const pattern = /`([^`\n]+)`/g
  let from = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > from) parts.push({ code: false, text: text.slice(from, match.index) })
    parts.push({ code: true, text: match[1]! })
    from = match.index + match[0].length
  }
  if (from < text.length) parts.push({ code: false, text: text.slice(from) })
  return parts
}

// Claude marks the option it would pick with "(Recommended)" after its label.
export const recommended = (label: string): { readonly label: string; readonly pick: boolean } => {
  const stripped = label.replace(/\s*\(Recommended\)\s*$/i, "")
  return { label: stripped, pick: stripped !== label }
}

const runs = /^(bash|shell|exec|run|command|powershell|run_command)/i
const edits = /(edit|write|patch|create|replace|notebook)/i

// What a permission is for, from the tool the harness names.
export type Action = "run" | "edit" | "plan" | "other"
export const actionOf = (request: ChatRequest): Action => {
  if (request.kind === "plan") return "plan"
  if (runs.test(request.tool)) return "run"
  if (edits.test(request.tool)) return "edit"
  return "other"
}

const firstQuestion = (dialog: ChatDialog | null): string | null =>
  dialog?.type === "questions" ? (dialog.questions[0]?.question ?? null) : null

const requestSubject = (request: ChatRequest): string => {
  if (request.kind === "question")
    return request.subject ?? firstQuestion(request.dialog) ?? "A question for you"
  const action = actionOf(request)
  const subject = request.subject
  if (action === "plan") return "Approve the plan?"
  if (action === "run") return subject ? `Run \`${subject}\`?` : "Run a command?"
  if (action === "edit") return subject ? `Edit \`${subject}\`?` : "Edit a file?"
  return subject ? `Use ${request.tool} on \`${subject}\`?` : `Use ${request.tool}?`
}

const troubleSubject = (trouble: Trouble, agent: AgentName): string => {
  if (trouble.type === "failed") return "Its turn ended in an error"
  if (trouble.type === "limit") {
    return `Hit ${agentName(agent)}'s ${limitWindow(trouble.minutes)} limit`
  }
  const times = Math.max(...trouble.evidence.map((line) => line.times), 0)
  return times > 1
    ? `Seems stuck: the same failure ${times} times`
    : "Seems stuck: the same failure again"
}

// The row's subject, as the person reads it first: what is asked, or what happened.
export const subjectOf = (item: InboxItem): string => {
  switch (item.kind) {
    case "request":
      return requestSubject(item.request)
    case "held":
      return `Release a held message to ${item.held.to.title}?`
    case "ask":
      return item.ask.subject
    case "trouble":
      return troubleSubject(item.trouble, item.source.agent)
    case "update":
      return item.update.subject
  }
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length

// What the person has to read, in words, for the "N min read" a long item carries.
const readWords = (item: InboxItem): number => {
  if (item.kind === "ask") {
    const { shape } = item.ask
    const options =
      shape.type === "options"
        ? shape.options.flatMap((option) => [option.label, option.summary ?? ""])
        : []
    return words([item.ask.body, ...options].join(" "))
  }
  if (item.kind === "update")
    return words(item.update.type === "told" ? item.update.body : item.update.reply)
  return 0
}

// "N min read" only where an item runs past about 120 words.
export const readLabel = (item: InboxItem): string | null => {
  const count = readWords(item)
  return count > 120 ? `${Math.max(1, Math.round(count / 120))} min read` : null
}

// Where an agent that Novadeck resumes picks up again.
export const resumesLabel = (item: InboxItem): string | null =>
  item.kind === "trouble" && item.trouble.type === "limit" && item.trouble.autoResume
    ? `Resumes at ${clock(item.trouble.resetsAt)}`
    : null

// The small line over a sheet's title: who wants what, in words a person would use.
export const labelOf = (item: InboxItem): string => {
  switch (item.kind) {
    case "request": {
      if (item.request.kind === "question") return "Asks you"
      const action = actionOf(item.request)
      if (action === "run") return "Wants to run a command"
      if (action === "edit") return "Wants to edit a file"
      if (action === "plan") return "Wants to go ahead with a plan"
      return `Wants to use ${item.request.tool}`
    }
    case "held":
      return "Novadeck held a message"
    case "ask":
      return "Asks you"
    case "trouble":
      return "Novadeck noticed"
    case "update":
      return item.update.type === "finished" ? "Finished" : "Heads-up"
  }
}

// Whether Novadeck itself speaks, which its sheets mark with its own glyph.
export const fromNovadeck = (item: InboxItem): boolean =>
  item.kind === "trouble" || item.kind === "held"

// The tone of an item's mark, by how it asks for the person: trouble that stopped the
// agent (urgent), anything that stopped it (waiting), anything else (quiet).
export type Tone = "urgent" | "waiting" | "quiet"
export const toneOf = (item: InboxItem): Tone => {
  if (!item.stopped) return "quiet"
  // A limit that waits for the person waits; it has not failed.
  const limit = item.kind === "trouble" && item.trouble.type === "limit"
  return inboxType(item) === "trouble" && !limit ? "urgent" : "waiting"
}

// A permission's or plan's options, as the buttons the sheet offers. Allow is a plain yes;
// the other yeses are quiet links in their own words, or plain buttons where none is plain;
// the rest say no, one of which may take words.
export type Choices = {
  // The plain yes that leads; null where no yes is plain.
  readonly allow: ChatDialogOption | null
  readonly standing: readonly ChatDialogOption[]
  // Where no yes leads, the ones that set nothing standing, offered as they word themselves.
  readonly unsure: readonly ChatDialogOption[]
  // The no that takes the person's words, and the plain one.
  readonly note: ChatDialogOption | null
  readonly plain: ChatDialogOption | null
}

const yes = /^(yes|allow|approve)\b/i
const no = /^(no|deny|reject)\b/i
const standing =
  /don't ask again|do not ask again|always|allow all|all edits|this session|for session|auto-accept/i

// Only these lead as the primary Allow or Approve: a bare yes, Codex's "Yes, proceed" and
// Claude's plan "manually approve edits". Everything else is a yes that may change more than
// this answer, whatever it says, so it never leads.
const bareYes = /^(yes|allow|approve)( once)?[.!]?$/i
const knownYes = /^yes,( and)? (proceed|manually approve edits)[.!]?$/i

// A label as the rule reads it: trimmed, and without a key hint the harness prints after
// it, as Codex's "(y)". Only these keys: any other bracket ("(all)", "(a)" for always) may
// qualify the answer, so it stays and the label is no bare yes.
const keyHint = /\s*\((y|n|esc|enter|tab|shift\+tab)\)$/i
const bare = (label: string): string => label.trim().replace(keyHint, "")

// Whether a yes sets something standing, by its own words: what its quiet link confirms.
export const setsStanding = (option: ChatDialogOption): boolean => standing.test(option.label)

// Null where nothing says yes: the person answers in the terminal. A bare yes leads, else
// a known one. With one leading, every other yes is a quiet link in its own words, so
// nothing that may change more than this answer ("bypass permissions") sits beside it as a
// button; with none leading, the yeses are plain buttons in their own words (`unsure`),
// none of them primary. Nothing is guessed at. A yes is never offered as a no; where
// nothing says no, there is no Deny.
export const choicesOf = (options: readonly ChatDialogOption[]): Choices | null => {
  const yeses = options.filter((each) => yes.test(bare(each.label)))
  if (yeses.length === 0) return null
  const allow =
    yeses.find((each) => bareYes.test(bare(each.label))) ??
    yeses.find((each) => knownYes.test(bare(each.label))) ??
    null
  const others = yeses.filter((each) => each !== allow)
  const nos = options.filter((each) => no.test(bare(each.label)))
  return {
    allow,
    standing: allow ? others : others.filter((each) => standing.test(each.label)),
    unsure: allow ? [] : others.filter((each) => !standing.test(each.label)),
    note: nos.find((each) => each.text !== null) ?? null,
    plain: nos.find((each) => each.text === null) ?? null,
  }
}

// The agent's words for a limit's window: "usage" where its length is unknown (0), and
// "weekly" and "daily" for the windows of those lengths.
export const limitWindow = (minutes: number): string => {
  if (minutes <= 0) return "usage"
  if (minutes === 10_080) return "weekly"
  if (minutes === 1440) return "daily"
  return minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`
}

// How an item stands, for the line over its sheet's title.
export type Standing = {
  readonly status: string
  readonly tone: "urgent" | "waiting" | "calm" | "done"
}
export const standingOf = (item: InboxItem, now: number, answered: boolean): Standing => {
  if (answered) return { status: "answered", tone: "done" }
  if (inboxType(item) === "update") {
    const ago = waitLabel(item.at, now)
    return { status: ago === "now" ? "just now" : `${ago} ago`, tone: "calm" }
  }
  if (item.kind === "trouble" && item.trouble.type === "limit" && item.trouble.autoResume)
    return {
      status:
        item.trouble.resetsAt <= now
          ? "resuming"
          : `resumes in ${waitLabel(now, item.trouble.resetsAt)}`,
      tone: "calm",
    }
  if (item.stopped)
    return {
      status: `waiting ${waitLabel(item.at, now)}`,
      tone: toneOf(item) === "urgent" ? "urgent" : "waiting",
    }
  return { status: "still working", tone: "done" }
}
