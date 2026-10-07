import {
  Bot,
  ChevronRight,
  FilePen,
  FileText,
  Globe,
  ListChecks,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react"
import { useId, useMemo, useState } from "react"

import {
  inputText,
  toolSummary,
  type ToolEntry,
  type ToolKind,
} from "../../model/conversation-turns"

const icons: Readonly<Record<ToolKind, LucideIcon>> = {
  run: SquareTerminal,
  read: FileText,
  write: FilePen,
  search: Search,
  web: Globe,
  agent: Bot,
  plan: ListChecks,
  other: Wrench,
}

// A run of this many calls or more folds into one line until opened.
const foldAt = 4

const Detail = ({
  label,
  text,
  truncated,
}: {
  readonly label: string
  readonly text: string
  readonly truncated: boolean
}): React.JSX.Element => (
  <section className="chat-tool-part" aria-label={label}>
    <h4>{label}</h4>
    {/* Focusable, so a long output can be scrolled by keyboard. */}
    <pre tabIndex={0} className="nodrag nopan nowheel">
      {text || "(empty)"}
    </pre>
    {truncated && <p className="chat-tool-note">Shortened here; the rest isn't carried over.</p>}
  </section>
)

const ToolRow = ({
  entry,
  running,
}: {
  readonly entry: ToolEntry
  // The agent works and this call has no result yet.
  readonly running: boolean
}): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const body = useId()
  const summary = useMemo(
    () =>
      entry.tool === null
        ? { kind: "other" as const, title: "Result", detail: "" }
        : toolSummary(entry.tool, entry.input),
    [entry.tool, entry.input],
  )
  const Icon = icons[summary.kind]
  return (
    <li className="chat-tool" data-kind={summary.kind} data-running={running || undefined}>
      <button
        type="button"
        className="chat-tool-summary nodrag nopan"
        aria-expanded={open}
        aria-controls={open ? body : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight size={12} className="chat-tool-chevron" aria-hidden />
        <Icon size={13} strokeWidth={1.75} className="chat-tool-icon" aria-hidden />
        <span className="chat-tool-title">{summary.title}</span>
        {summary.detail && <span className="chat-tool-detail">{summary.detail}</span>}
        {running && <span className="sr-only">(running)</span>}
      </button>
      {open && (
        <div id={body} className="chat-tool-body">
          {entry.tool !== null && (
            <Detail
              label={entry.tool === summary.title ? "Call" : `Call: ${entry.tool}`}
              text={inputText(entry.input)}
              truncated={entry.truncated}
            />
          )}
          {entry.result ? (
            <Detail label="Result" text={entry.result.text} truncated={entry.result.truncated} />
          ) : (
            <p className="chat-tool-note">{running ? "Running…" : "No result recorded."}</p>
          )}
        </div>
      )}
    </li>
  )
}

// Consecutive tool calls, as one card of one-line rows. A long run folds into a line that
// counts them.
export const ToolRun = ({
  entries,
  live,
}: {
  readonly entries: readonly ToolEntry[]
  // The latest block of a conversation whose agent works: its unanswered calls run.
  readonly live: boolean
}): React.JSX.Element => {
  const folds = entries.length >= foldAt
  const [open, setOpen] = useState(live)
  const list = useId()
  const rows = (
    <ul id={list} className="chat-tools-list">
      {entries.map((entry) => (
        <ToolRow
          key={entry.id}
          entry={entry}
          running={live && entry.result === null && entry.tool !== null}
        />
      ))}
    </ul>
  )
  if (!folds) return <div className="chat-tools">{rows}</div>
  return (
    <div className="chat-tools" data-folded={!open}>
      <button
        type="button"
        className="chat-tools-fold nodrag nopan"
        aria-expanded={open}
        aria-controls={open ? list : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight size={12} className="chat-tool-chevron" aria-hidden />
        <span className="chat-tool-title">{entries.length} tool calls</span>
        <span className="chat-tool-detail">
          {[...new Set(entries.map((entry) => toolSummary(entry.tool ?? "", entry.input).title))]
            .slice(0, 4)
            .join(", ")}
        </span>
      </button>
      {open && rows}
    </div>
  )
}
