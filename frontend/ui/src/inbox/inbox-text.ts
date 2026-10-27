import type { ChatDialog, ChatDialogOption, ChatRequest } from "@novadeck/core/conversation"
import { scrub, textToSend } from "@novadeck/core/feedback-scrub"
import { harnesses, type AgentName } from "@novadeck/core/harnesses"
import { inboxType, type InboxRow, type InboxSource, type Trouble } from "@novadeck/core/inbox"
import { unsaidWaits, waitsBehind } from "@novadeck/core/messages"

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

// A call that asks several questions names the first, and how many more wait behind it.
const moreQuestions = (dialog: ChatDialog | null): string =>
  dialog?.type === "questions" && dialog.questions.length > 1
    ? ` (+${dialog.questions.length - 1} more)`
    : ""

const requestSubject = (request: ChatRequest): string => {
  if (request.kind === "question")
    return `${request.subject ?? firstQuestion(request.dialog) ?? "A question for you"}${moreQuestions(request.dialog)}`
  const action = actionOf(request)
  const subject = request.subject
  if (action === "plan") return "Approve the plan?"
  if (action === "run") return subject ? `Run \`${subject}\`?` : "Run a command?"
  if (action === "edit") return subject ? `Edit \`${subject}\`?` : "Edit a file?"
  return subject ? `Use ${request.tool} on \`${subject}\`?` : `Use ${request.tool}?`
}

const troubleSubject = (trouble: Trouble, source: InboxSource): string => {
  if (trouble.type === "failed") return "Its turn ended in an error"
  if (trouble.type === "waits")
    return `${trouble.count === 1 ? "1 message" : `${trouble.count} messages`} for @${source.handle} ${trouble.count === 1 ? "waits" : "wait"} behind ${trouble.waits ? waitsBehind[trouble.waits] : unsaidWaits.behind}`
  if (trouble.type === "limit") {
    return `Hit ${agentName(source.agent)}'s ${limitWindow(trouble.minutes)} limit`
  }
  const times = Math.max(...trouble.evidence.map((line) => line.times), 0)
  return times > 1
    ? `Seems stuck: the same failure ${times} times`
    : "Seems stuck: the same failure again"
}

// A feedback draft's subject: who drafted it and how its text starts, cut at a line's end.
const feedbackSubject = (text: string, source: InboxSource): string => {
  // What the draft would send, so a path in its first line shows as `[path]` here too.
  const first = textToSend(scrub(text.trim().split("\n")[0]!.trim()))
  const head = first.length > 72 ? `${first.slice(0, 71).trimEnd()}…` : first
  return `Feedback draft from @${source.handle}${head ? `: ${head}` : ""}`
}

// The row's subject, as the person reads it first: what is asked, or what happened.
export const subjectOf = (item: InboxRow): string => {
  switch (item.kind) {
    case "request":
      return requestSubject(item.request)
    case "held":
      return `Release a held message to ${item.held.to.title}?`
    case "ask":
      return item.ask.subject
    case "trouble":
      return troubleSubject(item.trouble, item.source)
    case "update":
      return item.update.subject
    case "feedback":
      return feedbackSubject(item.draft.text, item.source)
  }
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length

// What the person has to read, in words, for the "N min read" a long item carries.
const readWords = (item: InboxRow): number => {
  if (item.kind === "ask") {
    const { shape } = item.ask
    const options =
      shape.type === "options"
        ? shape.options.flatMap((option) => [option.label, option.summary ?? ""])
        : []
    return words([item.ask.body, ...options].join(" "))
  }
  if (item.kind === "update") return words(item.update.body)
  return 0
}

// "N min read" only where an item runs past about 120 words.
export const readLabel = (item: InboxRow): string | null => {
  const count = readWords(item)
  return count > 120 ? `${Math.max(1, Math.round(count / 120))} min read` : null
}

// Where an agent that Novadeck resumes picks up again.
export const resumesLabel = (item: InboxRow): string | null =>
  item.kind === "trouble" && item.trouble.type === "limit" && item.trouble.autoResume
    ? `Resumes at ${clock(item.trouble.resetsAt)}`
    : null

// The small line over a sheet's title: who wants what, in words a person would use.
export const labelOf = (item: InboxRow): string => {
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
      return item.ask.shape.type === "action" ? "Needs you" : "Asks you"
    case "trouble":
      return "Novadeck noticed"
    case "update":
      return item.update.type === "done" ? "Done" : "Heads-up"
    case "feedback":
      return "Drafted feedback"
  }
}

// Whether Novadeck itself speaks, which its sheets mark with its own glyph.
export const fromNovadeck = (item: InboxRow): boolean =>
  item.kind === "trouble" || item.kind === "held"

// The tone of an item's mark, by how it asks for the person: trouble that stopped the
// agent (urgent), anything that stopped it (waiting), anything else (quiet).
export type Tone = "urgent" | "waiting" | "quiet"
export const toneOf = (item: InboxRow): Tone => {
  if (!item.stopped) return "quiet"
  // A limit that waits for the person waits, as do messages held for an idle agent: neither
  // has failed.
  const waits =
    item.kind === "trouble" && (item.trouble.type === "limit" || item.trouble.type === "waits")
  return inboxType(item) === "trouble" && !waits ? "urgent" : "waiting"
}

// A permission's or plan's options, as the buttons the sheet offers. Allow is a plain yes;
// the other yeses are quiet links in their own words, or plain buttons where none is plain;
// the rest say no, or send the person's words back, one of which may take words.
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
// The way back that is only the person's words, as Claude Code's plan field "Tell Claude
// what to change" (from 2.1.287; before, "No, keep planning") and "Tell it what to
// change", the label Novadeck's Antigravity adapter gives a review's feedback (Antigravity's
// screen has no such option): it says no only with words. The agent's name may be more
// than one word.
const change = /^tell .+? what to change\b/i
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

// Whether a way back must carry the person's words: it says no only with them.
export const needsWords = (option: ChatDialogOption): boolean => change.test(bare(option.label))

// Why an agent won't take these words in a field, said before they're sent; null where it
// will. Antigravity's feedback is typed into its empty prompt box, where words that start
// with /, ? or ! would run a command, open help or a shell, and an @ opens a file picker.
export const refusedWords = (
  agent: AgentName,
  option: ChatDialogOption,
  text: string,
): string | null =>
  agent === "agy" && option.text === "field" && /^\s*[/?!]|@/.test(text)
    ? `${agentName(agent)} can't take words that start with /, ? or !, or that have an @.`
    : null

// Null where nothing says yes: the person answers in the terminal. A bare yes leads, else
// a known one. With one leading, every other yes is a quiet link in its own words, so
// nothing that may change more than this answer ("bypass permissions") sits beside it as a
// button; with none leading, the yeses are plain buttons in their own words (`unsure`),
// none of them primary. Nothing is guessed at. A yes is never offered as a no; where
// nothing says no, nor sends words back, there is no Deny.
export const choicesOf = (options: readonly ChatDialogOption[]): Choices | null => {
  const yeses = options.filter((each) => yes.test(bare(each.label)))
  if (yeses.length === 0) return null
  const allow =
    yeses.find((each) => bareYes.test(bare(each.label))) ??
    yeses.find((each) => knownYes.test(bare(each.label))) ??
    null
  const others = yeses.filter((each) => each !== allow)
  // A way back that is only words counts where it takes them.
  const nos = options.filter(
    (each) => no.test(bare(each.label)) || (each.text !== null && needsWords(each)),
  )
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
