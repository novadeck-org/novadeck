import type { ChatDialog, ChatRequest } from "@novadeck/core/conversation"
import { harnesses, type AgentName } from "@novadeck/core/harnesses"
import type { InboxEntry, InboxSource, SettledHow, Trouble } from "@novadeck/core/inbox"
import { unsaidWaits, waitsBehind } from "@novadeck/core/messages"

// What the Inbox says about an entry, in words: pure, so the entries and the sheet read the
// same sentences, and so their rules read apart from the markup.

const minute = 60_000
const hour = 60 * minute

// The harness as a short word in a sentence; one a newer Novadeck integrates, as what it is.
export const agentName = (agent: AgentName | "newer"): string =>
  agent === "newer"
    ? "the agent"
    : (harnesses.find((each) => each.id === agent)?.shortName ?? agent)

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

// What a dialog of questions asks first, or what a form an MCP server asks for says it is for.
const firstQuestion = (dialog: ChatDialog | null): string | null =>
  dialog?.type === "questions"
    ? (dialog.questions[0]?.question ?? null)
    : dialog?.type === "form" && dialog.message.trim() !== ""
      ? dialog.message
      : null

// A call that asks several questions names the first, and how many more wait behind it.
const moreQuestions = (dialog: ChatDialog | null): string =>
  dialog?.type === "questions" && dialog.questions.length > 1
    ? ` (+${dialog.questions.length - 1} more)`
    : ""

const requestSubject = (request: ChatRequest): string => {
  if (request.kind === "question")
    return `${request.subject ?? firstQuestion(request.dialog) ?? "A question for you"}${moreQuestions(request.dialog)}`
  // A request Novadeck holds on the agent's behalf, as the shipping gate's card, asks its own
  // question in plain words: "Merge PR #1170 into main?".
  if (request.detached && request.dialog?.type === "choices" && request.dialog.title)
    return request.dialog.title
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

// The entry's subject, as the person reads it first: what is asked, or what happened.
export const subjectOf = (entry: InboxEntry): string => {
  switch (entry.kind) {
    case "request":
      return requestSubject(entry.request)
    case "held":
      return `Release a held message to ${entry.held.to.title}?`
    case "ask":
      return entry.ask.subject
    case "trouble":
      return troubleSubject(entry.trouble, entry.source)
    case "update":
      return entry.update.subject
    case "permit":
      return entry.permit.title
  }
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length

// What the person has to read, in words, for the "N min read" a long entry carries.
const readWords = (entry: InboxEntry): number => {
  if (entry.kind === "ask") {
    const { shape } = entry.ask
    const options =
      shape.type === "options"
        ? shape.options.flatMap((option) => [option.label, option.summary ?? ""])
        : shape.type === "questions"
          ? shape.questions.flatMap((question) => [
              question.question,
              ...question.options.flatMap((option) => [option.label, option.summary ?? ""]),
            ])
          : []
    return words([entry.ask.body, ...options].join(" "))
  }
  if (entry.kind === "update") return words(entry.update.body)
  return 0
}

// "N min read" only where an entry runs past about 120 words.
export const readLabel = (entry: InboxEntry): string | null => {
  const count = readWords(entry)
  return count > 120 ? `${Math.max(1, Math.round(count / 120))} min read` : null
}

// Where an agent that Novadeck resumes picks up again.
export const resumesLabel = (entry: InboxEntry): string | null =>
  entry.kind === "trouble" && entry.trouble.type === "limit" && entry.trouble.autoResume
    ? `Resumes at ${clock(entry.trouble.resetsAt)}`
    : null

// The small line over a sheet's title: who wants what, in words a person would use.
export const labelOf = (entry: InboxEntry): string => {
  switch (entry.kind) {
    case "request": {
      if (entry.request.kind === "question") return "Asks you"
      const action = actionOf(entry.request)
      if (action === "run") return "Wants to run a command"
      if (action === "edit") return "Wants to edit a file"
      if (action === "plan") return "Wants to go ahead with a plan"
      return `Wants to use ${entry.request.tool}`
    }
    case "held":
      return "Novadeck held a message"
    case "ask":
      return entry.ask.shape.type === "action" ? "Needs you" : "Asks you"
    case "trouble":
      return "Novadeck noticed"
    case "update":
      return entry.update.type === "done" ? "Done" : "Heads-up"
    case "permit":
      return "Allowed to ship"
  }
}

// Whether Novadeck itself speaks, which its sheets mark with its own glyph.
export const fromNovadeck = (entry: InboxEntry): boolean =>
  entry.kind === "trouble" || entry.kind === "held"

// How a resolved entry ended, as its row's second line says it, and as the sheet's tag does.
export const endedWords: Readonly<Record<SettledHow, string>> = {
  answered: "Answered",
  terminal: "Answered in the terminal",
  dismissed: "Dismissed",
  replied: "Replied in the terminal",
  released: "Released",
  stopped: "Stopped",
  worked: "Worked on",
  delivered: "Delivered",
  read: "Read",
  takenBack: "Taken back",
  lapsed: "Ended",
  gone: "Closed",
  ended: "Session ended",
  away: "Ended while Novadeck was closed",
}

// A resolved entry's one line, in the sheet where its menu was: what the person did, or why it
// asked nothing more, with the words they answered with.
export const endedLine = (entry: InboxEntry): string | null => {
  const { settled } = entry
  if (!settled) return null
  const who = `@${entry.source.handle}`
  const thing = entry.kind === "ask" ? "ask" : "request"
  switch (settled.how) {
    case "answered":
      return settled.answer ? `You answered: ${settled.answer}` : `You answered ${who}'s ${thing}.`
    case "terminal":
      return `You answered ${who}'s ${thing} in its terminal.`
    case "dismissed":
      return `You dismissed this entry. ${who} was told.`
    case "replied":
      return `You wrote to ${who} in its terminal, so this ask is closed.`
    case "released":
      return "You released this message."
    case "stopped":
      return "You stopped this thread."
    case "worked":
      return `${who} is working again.`
    case "delivered":
      return `${who} got its messages.`
    case "read":
      return "Read."
    case "takenBack":
      return `You took back ${who}'s permit.`
    case "lapsed":
      return `${who}'s permit no longer stands.`
    case "gone":
      return entry.kind === "trouble"
        ? "The messages no longer wait. They were stopped or withdrawn."
        : `Closed in the terminal, by an answer Novadeck didn't see.`
    case "ended":
      return `${who}'s agent session ended, or its terminal closed.`
    case "away":
      return "It ended while Novadeck was closed."
  }
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
