import { cells } from "@novadeck/emulator/width"

import type { ChatDialog, ChatItem, ChatRequest } from "#core/conversation"
import type { AgentStatus } from "#core/types"

import type { ChatAgent } from "../samples"
import type { Block, Tail } from "./screen"
import { box, characters, rule, span, wrap, type Line, type Span, type Style } from "./vt"

// What an agent's terminal shows, as its TUI draws it: the conversation, a block at a time,
// and under it the dialog of a request that waits, the status lines and the prompt.

export const clip = (text: string, length: number): string =>
  text.length > length ? `${text.slice(0, length)}…` : text

// A tool call's input as one line: the argument people read it by, else its first line.
export const summary = (input: string): string => {
  try {
    const parsed: unknown = JSON.parse(input)
    if (parsed && typeof parsed === "object") {
      for (const name of ["command", "file_path", "path", "pattern", "query", "description"]) {
        const value = (parsed as Record<string, unknown>)[name]
        if (typeof value === "string") return clip(value.split("\n")[0]!, 90)
      }
    }
  } catch {
    // Not JSON: read it as text.
  }
  return clip(input.trim().split("\n")[0] ?? "", 90)
}

// A tool's result as its first lines, clipped, with "…" where there was more.
export const resultLines = (item: ChatItem): string[] => {
  const lines = item.text.split("\n").filter((line) => line.trim())
  const shown = lines.slice(0, 3).map((line) => clip(line, 100))
  return lines.length > 3 || item.truncated
    ? [...shown.slice(0, -1), `${shown.at(-1) ?? ""}…`]
    : shown
}

const working = {
  claude: "✻ Working…",
  codex: "• Working",
  agy: "◆ Working…",
} as const

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`

// The lines under the conversation that say what the agent is doing.
export const statusLines = (
  agent: ChatAgent,
  status: AgentStatus | undefined,
  asking: boolean,
): string[] => {
  if (!status) return []
  const lines: string[] = []
  if (status.working && !asking) lines.push(`${working[agent]} (esc to interrupt)`)
  if (status.planning) lines.push("⏸ plan mode on")
  if (status.subagents?.length)
    lines.push(`⏺ ${plural(status.subagents.length, "subagent")} running`)
  const { agents = 0, tasks = 0 } = status.working ? {} : (status.background ?? {})
  if (agents || tasks) {
    const parts = [agents && plural(agents, "agent"), tasks && plural(tasks, "task")]
    lines.push(`⏵ ${parts.filter(Boolean).join(", ")} running in the background`)
  }
  return lines
}

// The glyph a person's request and a tool call start with, in each agent's TUI.
const promptGlyph = (agent: ChatAgent): string => (agent === "claude" ? "❯" : "›")
const callGlyph = (agent: ChatAgent): string => (agent === "claude" ? "●" : "•")

const gap: Line = []

// What a person asked, set apart by a blank row each side, and in bold behind the prompt's
// glyph in colour, so the person's own turns stand out from the agent's.
export const requestBlock =
  (agent: ChatAgent, text: string): Block =>
  (width) => [
    ...wrap([span(text, "bold")], width, {
      first: [span(`${promptGlyph(agent)} `, "bold", "cyan")],
      rest: [span("  ")],
    }),
    gap,
  ]

// A tool call: its name and what it was called on, after a blank row.
export const callBlock =
  (agent: ChatAgent, tool: string, subject = ""): Block =>
  (width) => [
    gap,
    ...wrap([span(tool, "bold"), ...(subject ? [span(` ${subject}`)] : [])], width, {
      first: [span(`${callGlyph(agent)} `)],
      rest: [span("  ")],
    }),
  ]

// A tool's result under its call, muted, the first line marked as its answer.
export const resultBlock =
  (lines: readonly string[]): Block =>
  (width) =>
    lines.flatMap((line, index) =>
      wrap([span(line, "muted")], width, {
        first: [span(index ? "    " : "  └ ", "muted")],
        rest: [span("    ")],
      }),
    )

// Text the agent says, after a blank row.
export const textBlock =
  (text: string, ...style: Style[]): Block =>
  (width) => [gap, ...wrap([span(text, ...style)], width)]

// A diff under a tool call: removed lines red, added ones green.
export const diffBlock =
  (lines: readonly string[]): Block =>
  (width) =>
    lines.flatMap((line) =>
      wrap(
        [span(line, line.startsWith("+") ? "green" : line.startsWith("−") ? "red" : "muted")],
        width,
        {
          first: [span("    ")],
          rest: [span("      ")],
        },
      ),
    )

// A rule across the screen with a note on it, as Codex ends a turn.
export const dividerBlock =
  (note: string): Block =>
  (width) => [gap, rule(width, note, "muted")]

// One record of the conversation, as the agent's TUI shows it.
export const itemBlock = (item: ChatItem, agent: ChatAgent): Block => {
  if (item.kind === "tool-call") return callBlock(agent, item.tool ?? "Tool", summary(item.text))
  if (item.kind === "tool-result") return resultBlock(resultLines(item))
  if (item.role === "user") {
    const asked = requestBlock(agent, item.text)
    return (width) => [gap, ...asked(width)]
  }
  if (item.role === "agent")
    return textBlock(`↳ ${item.author ? `${item.author}: ` : ""}${clip(item.text, 300)}`, "muted")
  return textBlock(item.text)
}

const tags = {
  permission: "Permission",
  question: "Question",
  plan: "Plan",
} as const

// The colour of each kind of request's box and tag, as the app marks them.
const tones = {
  permission: "yellow",
  question: "blue",
  plan: "magenta",
} as const satisfies Record<ChatRequest["kind"], Style>

const optionLines = (
  options: readonly { readonly label: string; readonly description?: string | null }[],
  width: number,
): Line[] =>
  options.flatMap((option, index) =>
    wrap(
      [
        span(`${index + 1}. ${option.label}`, ...(index ? (["muted"] as const) : [])),
        ...(option.description ? [span(` · ${option.description}`, "muted")] : []),
      ],
      width,
      { first: [span(index ? "  " : "❯ ")], rest: [span("     ")] },
    ),
  )

const hint = (text: string, width: number): Line[] => [gap, ...wrap([span(text, "muted")], width)]
const excerpt = (text: string | null, width: number): Line[] =>
  text ? wrap([span(clip(text, 400), "muted")], width) : []

const dialogLines = (
  request: ChatRequest,
  agent: ChatAgent,
  progress: number,
  width: number,
): Line[] => {
  const dialog: ChatDialog | null = request.dialog
  if (!dialog)
    return [
      ...wrap([span(request.tool, "bold")], width),
      ...excerpt(request.subject, width),
      ...hint("Waiting for the dialog to show…", width),
    ]
  if (dialog.type === "choices") {
    const title =
      dialog.title ??
      (request.kind === "plan"
        ? agent === "claude"
          ? "Ready to code?"
          : "Implement this plan?"
        : `Allow ${request.tool}?`)
    return [
      ...wrap([span(title, "bold")], width),
      ...excerpt(dialog.detail?.includes(request.subject ?? "") ? null : request.subject, width),
      ...excerpt(dialog.detail, width),
      gap,
      ...optionLines(dialog.options, width),
      ...hint(
        `Type a number and press Enter${dialog.options.some((option) => option.text) ? "; words after it go with it" : ""}.`,
        width,
      ),
    ]
  }
  if (dialog.type === "questions") {
    const question = dialog.questions[Math.min(progress, dialog.questions.length - 1)]!
    const counted =
      dialog.questions.length > 1
        ? [
            span(
              ` · ${Math.min(progress + 1, dialog.questions.length)} of ${dialog.questions.length}`,
              "muted",
            ),
          ]
        : []
    return [
      ...wrap([span(question.header ?? "Question", "bold"), ...counted], width),
      ...wrap([span(question.question)], width),
      gap,
      ...optionLines(question.options, width),
      ...hint(
        question.multiSelect
          ? "Type numbers, such as “1 3”, and press Enter."
          : "Type a number and press Enter.",
        width,
      ),
    ]
  }
  if (dialog.type === "form")
    return [
      ...wrap([span(dialog.message, "bold")], width),
      ...dialog.fields.flatMap((field) => wrap([span(`· ${field.label}`, "muted")], width)),
      ...hint("Answer this form from the chat, or type to go on.", width),
    ]
  return [
    ...wrap([span(dialog.text.split("\n").slice(0, 12).join("\n"))], width),
    ...hint("The agent's own dialog: answer it in the agent, or type to go on.", width),
  ]
}

// The dialog of the request the agent waits on, in a box marked with its kind: what it
// asks and the answers to type, or that it was answered and the agent is catching up.
export const askLines = (
  request: ChatRequest,
  agent: ChatAgent,
  progress: number,
  place: { readonly at: number; readonly of: number } | undefined,
  width: number,
): Line[] => {
  const tone = tones[request.kind]
  const tag = [
    tags[request.kind],
    ...(request.subagent ? ["subagent"] : []),
    ...(place && place.of > 1 ? [`${place.at} of ${place.of}`] : []),
  ].join(" · ")
  return box(
    width,
    (inner) => [
      [span(tag, "bold", tone)],
      ...(request.answered
        ? wrap([span("✓ Answered. Waiting for the agent…", "muted")], inner)
        : dialogLines(request, agent, progress, inner)),
    ],
    tone,
  )
}

// A line being typed after `prompt`, cut into rows of `width` columns as a line editor
// wraps it, with where its cursor is: at `cursor`, an offset into the draft as a string
// counts it, at the start of the character it falls in.
export const inputLines = (prompt: Line, draft: string, cursor: number, width: number): Tail => {
  const lead = prompt.reduce((sum, run) => sum + cells(run.text), 0)
  const rows: Span[][] = [[...prompt]]
  let used = lead
  let at = { row: 0, column: lead }
  let offset = 0
  for (const character of characters(draft)) {
    const each = cells(character)
    if (used + each > width) {
      rows.push([])
      used = 0
    }
    if (offset < cursor) at = { row: rows.length - 1, column: used }
    rows.at(-1)!.push(span(character))
    used += each
    offset += character.length
    if (offset <= cursor) at = { row: rows.length - 1, column: used }
  }
  // A cursor past a full row sits at the start of the next, as the terminal puts it.
  if (at.column >= width) {
    if (at.row === rows.length - 1) rows.push([])
    at = { row: at.row + 1, column: 0 }
  }
  return { lines: rows, cursor: at }
}

// The live tail of an agent's terminal: the request's dialog, a note on what the prompt
// couldn't take, the status lines, and the prompt between two rules, as Claude Code draws
// its input.
export const agentTail = ({
  agent,
  request,
  progress,
  place,
  note,
  status,
  draft,
  cursor,
  noteAgain = false,
}: {
  readonly agent: ChatAgent
  readonly request: ChatRequest | undefined
  readonly progress: number
  readonly place: { readonly at: number; readonly of: number } | undefined
  readonly note: string | undefined
  readonly status: readonly string[]
  readonly draft: string
  readonly cursor: number
  // Whether the note is said again, as the same refusal twice, so it's heard again.
  readonly noteAgain?: boolean
}): ((width: number) => Tail) => {
  return (width) => {
    const asking = request ? [gap, ...askLines(request, agent, progress, place, width)] : []
    const noted = note ? wrap([span(note, "muted")], width) : []
    const above: Line[] = [
      ...asking,
      ...noted,
      ...status.flatMap((line) => [gap, ...wrap([span(line, "muted")], width)]),
      gap,
      rule(width, undefined, "muted"),
    ]
    // Nothing but the draft on the prompt's row, as a reader of the screen takes it for one.
    const input = inputLines([span(`${promptGlyph(agent)} `, "bold")], draft, cursor, width)
    return {
      lines: [...above, ...input.lines, rule(width, undefined, "muted")],
      cursor: { row: above.length + input.cursor.row, column: input.cursor.column },
      ...(noteAgain && { fresh: noted.map((_, index) => asking.length + index) }),
    }
  }
}

// A shell's prompt: where it is, then the line being typed.
export const shellTail =
  ({
    project,
    branch = "main",
    draft,
    cursor,
  }: {
    readonly project: string
    readonly branch?: string
    readonly draft: string
    readonly cursor: number
  }): ((width: number) => Tail) =>
  (width) => {
    const above: Line[] = [
      gap,
      ...wrap([span(project, "cyan"), span(` ⎇ ${branch}`, "muted")], width),
    ]
    const input = inputLines([span("❯ ", "bold", "green")], draft, cursor, width)
    return {
      lines: [...above, ...input.lines],
      cursor: { row: above.length + input.cursor.row, column: input.cursor.column },
    }
  }
