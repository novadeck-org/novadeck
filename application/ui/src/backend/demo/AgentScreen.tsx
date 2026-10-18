import type { ChatDialog, ChatItem, ChatRequest, Conversation } from "#core/conversation"
import type { AgentStatus } from "#core/types"

import { chatAgents, type ChatAgent } from "./samples"

// What an agent's terminal shows after its intro, as the TUI would: the conversation
// since the terminal opened, the dialog of the request that waits, and the status line.

export type AgentTail = {
  readonly items: readonly ChatItem[]
  readonly request: ChatRequest | undefined
  readonly status: readonly string[]
  // Changes whenever the tail grows, for the surface to scroll it into view.
  readonly mark: string
}

const working = {
  claude: "✻ Working…",
  codex: "• Working",
  agy: "◆ Working…",
} as const

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`

const statusLines = (
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

export const tailOf = (
  agent: ChatAgent,
  conversation: Conversation,
  opening: number,
  status: AgentStatus | undefined,
  request: ChatRequest | undefined,
): AgentTail => {
  const items = conversation.items.slice(opening)
  // A dialog that waits on the person is not work, whatever the agent still reports.
  const lines = statusLines(agent, status, request !== undefined && !request.answered)
  return {
    items,
    request,
    status: lines,
    mark: `${items.length}|${request?.id ?? ""}${request?.answered ? "!" : ""}|${lines.length}`,
  }
}

const clip = (text: string, length: number): string =>
  text.length > length ? `${text.slice(0, length)}…` : text

// A tool call's input as one line: the argument people read it by, else its first line.
const summary = (input: string): string => {
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

const resultLines = (item: ChatItem): string[] => {
  const lines = item.text.split("\n").filter((line) => line.trim())
  const shown = lines.slice(0, 3).map((line) => clip(line, 100))
  return lines.length > 3 || item.truncated
    ? [...shown.slice(0, -1), `${shown.at(-1) ?? ""}…`]
    : shown
}

const Item = ({ item, agent }: { item: ChatItem; agent: ChatAgent }): React.JSX.Element => {
  if (item.kind === "tool-call")
    return (
      <p className="agent-tool mt-4">
        {agent === "claude" ? "●" : "•"} <strong>{item.tool ?? "Tool"}</strong> {summary(item.text)}
      </p>
    )
  if (item.kind === "tool-result")
    return (
      <p className="agent-tool-result pl-3 muted whitespace-pre-wrap">
        {resultLines(item)
          .map((line, index) => `${index ? "\u00a0 " : "└ "}${line}`)
          .join("\n")}
      </p>
    )
  if (item.role === "user")
    return (
      <p className="agent-request mt-4 mb-4 px-3 py-2 whitespace-pre-wrap">
        {agent === "claude" ? "❯" : "›"} {item.text}
      </p>
    )
  if (item.role === "agent")
    return (
      <p className="mt-4 muted whitespace-pre-wrap">
        ↳ {item.author ? `${item.author}: ` : ""}
        {clip(item.text, 300)}
      </p>
    )
  return <p className="mt-4 whitespace-pre-wrap">{item.text}</p>
}

const tags = {
  permission: "Permission",
  question: "Question",
  plan: "Plan",
} as const

const Options = ({
  options,
}: {
  options: readonly {
    id: string
    label: string
    description?: string | null
  }[]
}): React.JSX.Element => (
  <div className="mt-2">
    {options.map((option, index) => (
      <p key={option.id} className={index ? "muted" : undefined}>
        <span className="whitespace-pre">{index ? "  " : "❯ "}</span>
        {index + 1}. {option.label}
        {option.description && <span className="muted"> · {option.description}</span>}
      </p>
    ))}
  </div>
)

const excerpt = (text: string | null): React.JSX.Element | null =>
  text ? <p className="mt-1 muted whitespace-pre-wrap">{clip(text, 400)}</p> : null

const Body = ({
  request,
  agent,
  progress,
}: {
  request: ChatRequest
  agent: ChatAgent
  progress: number
}): React.JSX.Element => {
  const dialog: ChatDialog | null = request.dialog
  if (!dialog)
    return (
      <>
        <p>
          <strong>{request.tool}</strong>
        </p>
        {excerpt(request.subject)}
        <p className="mt-2 muted text-[0.85em]">Waiting for the dialog to show…</p>
      </>
    )
  if (dialog.type === "choices")
    return (
      <>
        <p>
          <strong>
            {dialog.title ??
              (request.kind === "plan"
                ? agent === "claude"
                  ? "Ready to code?"
                  : "Implement this plan?"
                : `Allow ${request.tool}?`)}
          </strong>
        </p>
        {excerpt(dialog.detail?.includes(request.subject ?? "") ? null : request.subject)}
        {excerpt(dialog.detail)}
        <Options options={dialog.options} />
        <p className="mt-2 muted text-[0.85em]">
          Type a number and press Enter
          {dialog.options.some((option) => option.text) ? "; words after it go with it" : ""}.
        </p>
      </>
    )
  if (dialog.type === "questions") {
    const question = dialog.questions[Math.min(progress, dialog.questions.length - 1)]!
    return (
      <>
        <p>
          <strong>{question.header ?? "Question"}</strong>
          {dialog.questions.length > 1 && (
            <span className="muted">
              {" "}
              · {Math.min(progress + 1, dialog.questions.length)} of {dialog.questions.length}
            </span>
          )}
        </p>
        <p className="mt-1 whitespace-pre-wrap">{question.question}</p>
        <Options options={question.options} />
        <p className="mt-2 muted text-[0.85em]">
          {question.multiSelect
            ? "Type numbers, such as “1 3”, and press Enter."
            : "Type a number and press Enter."}
        </p>
      </>
    )
  }
  if (dialog.type === "form")
    return (
      <>
        <p>
          <strong>{dialog.message}</strong>
        </p>
        {dialog.fields.map((field) => (
          <p key={field.id} className="muted">
            · {field.label}
          </p>
        ))}
        <p className="mt-2 muted text-[0.85em]">
          Answer this form from the chat, or type to go on.
        </p>
      </>
    )
  return (
    <>
      <p className="whitespace-pre-wrap">{dialog.text.split("\n").slice(0, 12).join("\n")}</p>
      <p className="mt-2 muted text-[0.85em]">
        The agent&apos;s own dialog: answer it in the agent, or type to go on.
      </p>
    </>
  )
}

export const AgentScreen = ({
  agent,
  tail,
  progress,
  place,
  note,
  noteKey,
}: {
  agent: ChatAgent
  tail: AgentTail
  // How many of a questions dialog's questions are answered.
  progress: number
  // The shown request's place among those waiting; shown where there are several.
  place: { readonly at: number; readonly of: number } | undefined
  // Muted line under the dialog: why a line wasn't taken.
  note: string | undefined
  // Changes with each note, so a repeat of the same text is rendered and announced anew.
  noteKey: number
}): React.JSX.Element => {
  const { items, request, status } = tail
  return (
    <div
      className={`agent-transcript agent-tail max-w-180 [overflow-wrap:anywhere] leading-[1.65] agent-${agent}`}
      data-agent={chatAgents[agent]}
    >
      {items.map((item) => (
        <Item key={item.id} item={item} agent={agent} />
      ))}
      {request && (
        <div
          className={`agent-ask agent-ask-${request.kind} mt-5 px-3 py-2`}
          data-kind={request.kind}
          data-answered={request.answered || undefined}
        >
          <p className="agent-ask-tag text-[0.8em] font-semibold">
            {tags[request.kind]}
            {request.subagent && " · subagent"}
            {place && place.of > 1 && ` · ${place.at} of ${place.of}`}
          </p>
          {request.answered ? (
            <p className="mt-1 muted">✓ Answered. Waiting for the agent…</p>
          ) : (
            <div className="mt-1">
              <Body request={request} agent={agent} progress={progress} />
            </div>
          )}
        </div>
      )}
      {/* Mounted while empty too, so a note that comes up is announced. */}
      <p role="status" className={`agent-note muted text-[0.85em]${note ? " mt-2" : ""}`}>
        <span key={noteKey}>{note}</span>
      </p>
      {status.map((line) => (
        <p key={line} className="agent-completion mt-3 muted text-[0.85em]">
          {line}
        </p>
      ))}
    </div>
  )
}
