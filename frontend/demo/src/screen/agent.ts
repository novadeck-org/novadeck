import type { ChatDialog, ChatItem, ChatRequest } from "@novadeck/core/conversation"
import type { AgentStatus } from "@novadeck/core/types"
import { cells } from "@novadeck/emulator/width"

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

const workingWords = {
  claude: "✻ Working…",
  codex: "• Working",
  agy: "◆ Working…",
  // OpenCode's footer while a turn runs (harnesses/opencode's input-box fixture).
  opencode: "■■■■■■⬝⬝  esc interrupt",
  // Pi shows it on the input box's top rule, not as a line (see `agentTail`).
  pi: "⠼ Working",
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
  // OpenCode and Pi draw it on their input box, not as a line (see `agentTail`).
  if (status.working && !asking && agent !== "pi" && agent !== "opencode")
    lines.push(`${workingWords[agent]} (esc to interrupt)`)
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
// Antigravity's are from harnesses/agy's probes: `> ` for the person's turn, `● Tool(subject)`
// for a call, and `  ⎿  ` before a result.
// OpenCode marks the person's turns with its left border, and Pi (which draws no marker, its
// text from the first column) with nothing (harnesses/pi's input-box fixture).
const promptGlyph = (agent: ChatAgent): string =>
  agent === "claude"
    ? "❯"
    : agent === "agy"
      ? ">"
      : agent === "opencode"
        ? "┃"
        : agent === "pi"
          ? ""
          : "›"
const callGlyph = (agent: ChatAgent): string => (agent === "codex" ? "•" : "●")

// Pi's call: a command as `$ command`, any other tool by its lowercase name and what it was
// called on (its transcript's names: read, edit, write; harnesses/pi's tools.ts).
const piCall = (tool: string, subject: string): string =>
  tool === "Bash" || tool === "Ran" ? `$ ${subject}` : `${tool.toLowerCase()} ${subject}`.trim()

// OpenCode's call: a command as `$ command`, a file written or edited as `← Edit file`, any
// other tool as `→ Tool subject` (harnesses/opencode's tools), under the reply's five columns.
const openCodeCall = (tool: string, subject: string): string =>
  tool === "Bash" || tool === "Ran"
    ? `$ ${subject}`
    : tool === "Write" || tool === "Edit" || tool === "Update"
      ? `← ${tool === "Write" ? "Write" : "Edit"} ${subject}`
      : `→ ${tool} ${subject}`.trim()

const gap: Line = []

// What a person asked, set apart by a blank row each side, and in bold behind the prompt's
// glyph in colour, so the person's own turns stand out from the agent's.
export const requestBlock =
  (agent: ChatAgent, text: string): Block =>
  (width) =>
    agent === "opencode"
      ? [
          // The person's turn between border rows, as harnesses/opencode's fixtures show it.
          [span("  ┃", "cyan")],
          ...wrap([span(text, "bold")], width, {
            first: [span("  ┃  ", "cyan")],
            rest: [span("  ┃  ", "cyan")],
          }),
          [span("  ┃", "cyan")],
          gap,
        ]
      : [
          ...wrap([span(text, "bold")], width, {
            first: [span(agent === "pi" ? " " : `${promptGlyph(agent)} `, "bold", "cyan")],
            rest: [span(agent === "pi" ? " " : "  ")],
          }),
          gap,
        ]

// A tool call: its name and what it was called on, after a blank row. Antigravity's reads
// `● Ran (command)`, and the blank row before a call is left out where the call follows
// another call or the person's turn (`joined`: that one has its own, as harnesses/agy's probes
// show in ask.probe.1.3.0.json and ask.probe.1.4.3.json), and its latest call is the one marked `(ctrl+o to expand)`
// (`expandable`).
export const callBlock =
  (agent: ChatAgent, tool: string, subject = "", expandable = false, joined = false): Block =>
  (width) =>
    agent === "opencode"
      ? [
          gap,
          ...wrap([span(openCodeCall(tool, subject), "bold")], width, {
            first: [span("     ")],
            rest: [span("       ")],
          }),
        ]
      : agent === "pi"
        ? [
            gap,
            ...wrap([span(piCall(tool, subject), "bold")], width, {
              first: [span(" ")],
              rest: [span("   ")],
            }),
          ]
        : [
            ...(agent === "agy" && joined ? [] : [gap]),
            ...wrap(
              [
                span(tool, "bold"),
                ...(subject ? [span(agent === "agy" ? ` (${subject})` : ` ${subject}`)] : []),
                ...(agent === "agy" && expandable ? [span(" (ctrl+o to expand)", "muted")] : []),
              ],
              width,
              {
                first: [span(`${callGlyph(agent)} `)],
                rest: [span("  ")],
              },
            ),
          ]

// A tool's result under its call, muted, the first line marked as its answer. Pi's, as
// harnesses/pi's input-box fixture shows a finished command: a blank row, the output a space in,
// and, once it finished, `Took 0.0s`. OpenCode's is the output under the call's five columns.
export const resultBlock =
  (lines: readonly string[], agent?: ChatAgent, took = false): Block =>
  (width) => {
    if (agent === "pi")
      return [
        gap,
        ...lines.flatMap((line) =>
          wrap([span(line, "muted")], width, { first: [span(" ")], rest: [span(" ")] }),
        ),
        ...(took ? [[span(" Took 0.0s", "muted")] satisfies Line] : []),
      ]
    if (agent === "opencode")
      return lines.flatMap((line) =>
        wrap([span(line, "muted")], width, { first: [span("     ")], rest: [span("     ")] }),
      )
    return lines.flatMap((line, index) => {
      const indent = agent === "agy" ? "     " : "    "
      return wrap([span(line, "muted")], width, {
        first: [span(index ? indent : agent === "agy" ? "  ⎿  " : "  └ ", "muted")],
        rest: [span(indent)],
      })
    })
  }

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
// Antigravity's own words for a call where its probes show them: `Ran (echo approved)`,
// `Ran 2 commands (echo same ×2)` for the same command run twice in a row, and
// `Edited 1 file (probe.txt)` for a file written or edited. Any other kind of call has no probe,
// so it reads as it did before: the tool's name and what it was called on.
const agyCall = (item: ChatItem, times: number): { tool: string; subject: string } => {
  const detail = clip(item.run?.detail.split("\n")[0] ?? "", 90)
  if (item.run?.kind === "run")
    return times > 1
      ? { tool: `${item.run.title} ${times} commands`, subject: `${detail} ×${times}` }
      : { tool: item.run.title, subject: detail }
  if (item.run?.kind === "write") return { tool: "Edited 1 file", subject: detail }
  return { tool: item.tool ?? "Tool", subject: summary(item.text) }
}

// Antigravity's screen of a conversation: calls that follow one another without a blank row,
// the same command run twice in a row as one call, no output under a call (it has some only
// under its slash commands), and only the latest call marked as one that expands.
export const agyBlocks = (items: readonly ChatItem[]): Block[] => {
  const visible = items.filter((item) => item.kind !== "tool-result")
  const latest = visible.findLast((item) => item.kind === "tool-call")
  const blocks: Block[] = []
  let previous: ChatItem | undefined
  for (let index = 0; index < visible.length; index += 1) {
    const item = visible[index]!
    if (item.kind !== "tool-call") {
      blocks.push(itemBlock(item, "agy"))
      previous = item
      continue
    }
    const repeats = (other: ChatItem | undefined): boolean =>
      other?.kind === "tool-call" &&
      item.run?.kind === "run" &&
      other.run?.kind === "run" &&
      other.run.detail === item.run.detail
    let times = 1
    while (repeats(visible[index + times])) times += 1
    const last = visible[index + times - 1]!
    index += times - 1
    const { tool, subject } = agyCall(item, times)
    // Only text of the agent's leaves its blank row before a call.
    const joined = !(previous && previous.kind === "text" && previous.role !== "user")
    blocks.push(callBlock("agy", tool, subject, last === latest, joined))
    previous = last
  }
  return blocks
}

// One record of the conversation, as the agent's TUI shows it. Antigravity's calls are laid out
// together (`agyBlocks`); alone, one is drawn as the latest and as following text.
export const itemBlock = (item: ChatItem, agent: ChatAgent): Block => {
  if (item.kind === "tool-call" && agent === "agy") {
    const { tool, subject } = agyCall(item, 1)
    return callBlock(agent, tool, subject, true, false)
  }
  if (item.kind === "tool-call") return callBlock(agent, item.tool ?? "Tool", summary(item.text))
  if (item.kind === "tool-result" && agent === "agy") return () => []
  if (item.kind === "tool-result") return resultBlock(resultLines(item), agent, agent === "pi")
  if (item.role === "user") {
    const asked = requestBlock(agent, item.text)
    return (width) => [gap, ...asked(width)]
  }
  if (item.role === "agent")
    return textBlock(`↳ ${item.author ? `${item.author}: ` : ""}${clip(item.text, 300)}`, "muted")
  // Antigravity indents what it says by two columns.
  if (agent === "agy")
    return (width) => [
      gap,
      ...wrap([span(item.text)], width, { first: [span("  ")], rest: [span("  ")] }),
    ]
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
  if (dialog.type === "newer")
    return hint("This needs a newer Novadeck: answer it in the agent, or type to go on.", width)
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

// Pi's input box (harnesses/pi's input-box and busy fixtures): its text from the first column
// between two full-width rules, the top one carrying a spinner and `Working` while a turn runs,
// and under it the folder and a line of usage and model.
const piRule = (width: number, label?: string): Line => {
  const head = label ? `── ${label} ` : ""
  return [span(head + "─".repeat(Math.max(0, width - cells(head))), "muted")]
}
const piModel = "gpt-6-luna • medium"
const openCodeModel = "GPT-6 Luna"
const piTail = ({
  request,
  progress,
  place,
  note,
  status,
  draft,
  cursor,
  noteAgain,
  working,
  directory,
  width,
}: {
  readonly request: ChatRequest | undefined
  readonly progress: number
  readonly place: { readonly at: number; readonly of: number } | undefined
  readonly note: string | undefined
  readonly status: readonly string[]
  readonly draft: string
  readonly cursor: number
  readonly noteAgain: boolean
  readonly working: boolean
  readonly directory: string
  readonly width: number
}): Tail => {
  const asking = request ? [gap, ...askLines(request, "pi", progress, place, width)] : []
  const noted = note ? wrap([span(note, "muted")], width) : []
  const above: Line[] = [
    ...asking,
    ...noted,
    ...status.flatMap((line) => [gap, ...wrap([span(line, "muted")], width)]),
    gap,
    piRule(width, working && !request ? "⠼ Working" : undefined),
  ]
  const input = inputLines([], draft, cursor, width)
  const usage = "0.7%/200k (auto)"
  const spare = Math.max(1, width - usage.length - piModel.length)
  return {
    lines: [
      ...above,
      ...input.lines,
      piRule(width),
      [span(directory.replace(/^\/home\/[^/]+\//, "~/"), "muted")],
      [span(usage + " ".repeat(spare) + piModel, "muted")],
    ],
    cursor: { row: above.length + input.cursor.row, column: input.cursor.column },
    ...(noteAgain && { fresh: noted.map((_, index) => asking.length + index) }),
  }
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
  working = false,
  directory = "",
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
  // Pi shows its turn running on its box's top rule, and the folder under the box.
  readonly working?: boolean
  readonly directory?: string
}): ((width: number) => Tail) => {
  return (width) => {
    if (agent === "pi")
      return piTail({
        request,
        progress,
        place,
        note,
        draft,
        cursor,
        noteAgain,
        working,
        directory,
        status,
        width,
      })
    const asking = request ? [gap, ...askLines(request, agent, progress, place, width)] : []
    const noted = note ? wrap([span(note, "muted")], width) : []
    if (agent === "opencode") {
      // OpenCode's input box (harnesses/opencode's input-box fixture): border rows round the
      // text, the agent and model under it, a bottom edge, and under that the working line and
      // the keys.
      const above: Line[] = [
        ...asking,
        ...noted,
        ...status.flatMap((line) => [gap, ...wrap([span(line, "muted")], width)]),
        gap,
        [span("  ┃", "cyan")],
      ]
      const input = inputLines([span("  ┃  ", "cyan")], draft, cursor, width)
      const left = working && !request ? `   ${workingWords.opencode}` : ""
      const keys = "tab agents  ctrl+p commands"
      return {
        lines: [
          ...above,
          ...input.lines,
          [span("  ┃", "cyan")],
          [span("  ┃  ", "cyan"), span(`Build · ${openCodeModel}`, "muted")],
          [span(`  ╹${"▀".repeat(Math.max(0, width - 3))}`, "muted")],
          [
            span(
              left + " ".repeat(Math.max(1, width - left.length - keys.length - 1)) + keys,
              "muted",
            ),
          ],
        ],
        cursor: { row: above.length + input.cursor.row, column: input.cursor.column },
        ...(noteAgain && { fresh: noted.map((_, index) => asking.length + index) }),
      }
    }
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
