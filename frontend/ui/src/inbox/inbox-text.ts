import type { ChatDialog, ChatDialogOption, ChatRequest } from "@novadeck/core/conversation"
import {
  needsWords,
  optionExtras,
  saysYes,
  type OptionRole,
} from "@novadeck/core/conversation/extras"
import { harnesses, type AgentName } from "@novadeck/core/harnesses"
import { inboxType, type InboxRow, type InboxSource, type Trouble } from "@novadeck/core/inbox"
import { unsaidWaits, waitsBehind } from "@novadeck/core/messages"

// What the Inbox says about a row, in words: pure, so the rows and the sheet read the
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
// An MCP server's tool, named by its server: its name says nothing of files or commands.
const mcpTool = /^mcp_/i

// What a permission is for, from the tool the harness names.
export type Action = "run" | "edit" | "plan" | "other"
export const actionOf = (request: ChatRequest): Action => {
  if (request.kind === "plan") return "plan"
  if (mcpTool.test(request.tool)) return "other"
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
    return `Hit ${agentName(source.agent)}'s ${limitWindow(trouble.minutes, trouble.scope)} limit`
  }
  const times = Math.max(...trouble.evidence.map((line) => line.times), 0)
  return times > 1
    ? `Seems stuck: the same failure ${times} times`
    : "Seems stuck: the same failure again"
}

// The row's subject, as the person reads it first: what is asked, or what happened.
export const subjectOf = (row: InboxRow): string => {
  switch (row.kind) {
    case "request":
      return requestSubject(row.request)
    case "held":
      return `Release a held message to ${row.held.to.title}?`
    case "ask":
      return row.ask.subject
    case "trouble":
      return troubleSubject(row.trouble, row.source)
    case "update":
      return row.update.subject
  }
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length

// What the person has to read, in words, for the "N min read" a long row carries.
const readWords = (row: InboxRow): number => {
  if (row.kind === "ask") {
    const { shape } = row.ask
    const options =
      shape.type === "options"
        ? shape.options.flatMap((option) => [option.label, option.summary ?? ""])
        : []
    return words([row.ask.body, ...options].join(" "))
  }
  if (row.kind === "update") return words(row.update.body)
  return 0
}

// "N min read" only where a row runs past about 120 words.
export const readLabel = (row: InboxRow): string | null => {
  const count = readWords(row)
  return count > 120 ? `${Math.max(1, Math.round(count / 120))} min read` : null
}

// Where an agent that Novadeck resumes picks up again.
export const resumesLabel = (row: InboxRow): string | null =>
  row.kind === "trouble" && row.trouble.type === "limit" && row.trouble.autoResume
    ? `Resumes at ${clock(row.trouble.resetsAt)}`
    : null

// The small line over a sheet's title: who wants what, in words a person would use.
export const labelOf = (row: InboxRow): string => {
  switch (row.kind) {
    case "request": {
      if (row.request.kind === "question") return "Asks you"
      const action = actionOf(row.request)
      if (action === "run") return "Wants to run a command"
      if (action === "edit") return "Wants to edit a file"
      if (action === "plan") return "Wants to go ahead with a plan"
      return `Wants to use ${row.request.tool}`
    }
    case "held":
      return "Novadeck held a message"
    case "ask":
      return row.ask.shape.type === "action" ? "Needs you" : "Asks you"
    case "trouble":
      return "Novadeck noticed"
    case "update":
      return row.update.type === "done" ? "Done" : "Heads-up"
  }
}

// Whether Novadeck itself speaks, which its sheets mark with its own glyph.
export const fromNovadeck = (row: InboxRow): boolean =>
  row.kind === "trouble" || row.kind === "held"

// The tone of a row's mark, by how it asks for the person: trouble that stopped the
// agent (urgent), anything that stopped it (waiting), anything else (quiet).
export type Tone = "urgent" | "waiting" | "quiet"
export const toneOf = (row: InboxRow): Tone => {
  if (!row.stopped) return "quiet"
  // A limit that waits for the person waits, as do messages held for an idle agent: neither
  // has failed.
  const waits =
    row.kind === "trouble" && (row.trouble.type === "limit" || row.trouble.type === "waits")
  return inboxType(row) === "trouble" && !waits ? "urgent" : "waiting"
}

// A permission's or plan's options, as the buttons the sheet offers, by the roles core's
// extras read them in: Allow is the plain yes; the other yeses are quiet links in their own
// words, or plain buttons where no yes is plain; the rest say no, or send the person's words
// back, one of which may take words. An option no rule knows is offered as it words itself.
export type Choices = {
  // The plain yes that leads; null where no yes is plain.
  readonly allow: ChatDialogOption | null
  readonly standing: readonly ChatDialogOption[]
  // Where no yes leads, the ones that set nothing standing, offered as they word themselves.
  readonly unsure: readonly ChatDialogOption[]
  // The no that takes the person's words, and the plain one.
  readonly note: ChatDialogOption | null
  readonly plain: ChatDialogOption | null
  // Every other option, as it words itself: one no rule knows, or a second no.
  readonly rest: readonly ChatDialogOption[]
}

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

// Null where it has nothing to send. With a yes leading, every other yes is a quiet link in
// its own words, so nothing that may change more than this answer ("bypass permissions")
// sits beside it as a button; with none leading, the yeses are plain buttons in their own
// words (`unsure`), none of them primary. A yes is never offered as a no; where nothing says
// no, nor sends words back, there is no Deny. Only the first option that takes words gets
// a box; an option that must carry words and has none is left to the terminal.
export const choicesOf = (options: readonly ChatDialogOption[]): Choices | null => {
  // Grouping reads no plan's effects, so any kind does.
  const extras = optionExtras("permission", options)
  const role = (option: ChatDialogOption): OptionRole => extras[options.indexOf(option)]!.role
  const allow = options.find((each) => role(each) === "yes") ?? null
  const others = options.filter((each) => each !== allow && saysYes(each))
  const standing = allow ? others : others.filter((each) => role(each) === "standing")
  const unsure = allow ? [] : others.filter((each) => role(each) !== "standing")
  const note = options.find((each) => role(each) === "words") ?? null
  const plain = options.find((each) => role(each) === "no") ?? null
  const placed = new Set([allow, ...standing, ...unsure, note, plain])
  const rest = options.filter((each) => !placed.has(each) && !needsWords(each))
  if (placed.size === 1 && placed.has(null) && rest.length === 0) return null
  return { allow, standing, unsure, note, plain, rest }
}

// The agent's words for a limit's window: "usage" where its length is unknown (0), and
// "weekly" and "daily" for the windows of those lengths; with the models it covers, where
// not all of them, after its length ("weekly Fable") or before "usage" ("Gemini usage").
export const limitWindow = (minutes: number, scope?: string): string => {
  const length =
    minutes <= 0
      ? "usage"
      : minutes === 10_080
        ? "weekly"
        : minutes === 1440
          ? "daily"
          : minutes % 60 === 0
            ? `${minutes / 60}-hour`
            : `${minutes}-minute`
  if (scope === undefined) return length
  return minutes <= 0 ? `${scope} usage` : `${length} ${scope}`
}
