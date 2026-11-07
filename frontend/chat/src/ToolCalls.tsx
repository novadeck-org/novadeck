import type { ToolChange } from "@novadeck/core/conversation"
import type { ToolEntry } from "@novadeck/core/conversation/turns"
import { counted } from "@novadeck/core/units"
import { useId, useState } from "react"

import { inputBeyondLine } from "./input-text"
import { shownControls } from "./shown-controls"
import {
  callRun,
  failedCount,
  foldSummary,
  moreChanged,
  runningVerb,
  toolLines,
  toolNote,
  verbOf,
  type ToolLine,
  type ToolNote,
} from "./tool-lines"

// A run of this many lines or more folds into one until opened.
const foldAt = 4

// What came of the call, after its words. A change's counts stand apart, without the dot.
const Note = ({ note }: { readonly note: ToolNote }): React.JSX.Element =>
  note.kind === "change" ? (
    <span className="chat-tool-said">
      {"  "}
      <span className="chat-tool-added">+{note.added}</span>{" "}
      <span className="chat-tool-removed">−{note.removed}</span>
    </span>
  ) : (
    <span className={note.kind === "failed" ? "chat-tool-said chat-tool-failed" : "chat-tool-said"}>
      {" "}
      · {note.text}
    </span>
  )

// How many of the calls a line stands for failed, as closed they'd go unseen.
const Failed = ({ count }: { readonly count: number }): React.JSX.Element | null =>
  count > 0 ? <span className="chat-tool-failed"> · {count} failed</span> : null

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
    {/* Focusable, so a long output can be scrolled by keyboard. */}
    <pre tabIndex={0} className="nodrag nopan nowheel">
      {shownControls(text) || "(empty)"}
    </pre>
    {truncated && <p className="chat-tool-note">Shortened here; the rest isn't carried over.</p>}
  </section>
)

// The lines a call changed, each with its number where the harness records one, and how many
// more it counted.
const Changes = ({ change }: { readonly change: ToolChange }): React.JSX.Element => {
  const more = moreChanged(change)
  return (
    <section className="chat-tool-part" aria-label="Changes">
      <pre tabIndex={0} className="nodrag nopan nowheel">
        {change.lines.map((line, at) => (
          // A line of a diff has no identity but its place.
          // eslint-disable-next-line react/no-array-index-key
          <span key={at} className="chat-diff" data-sign={line.sign}>
            {String(line.line ?? "").padStart(3)} {line.sign} {shownControls(line.text)}
          </span>
        ))}
        {more > 0 && <span className="chat-diff">… +{counted(more, "line")}</span>}
      </pre>
    </section>
  )
}

const ToolRow = ({
  line: { entry, scripted },
  live,
}: {
  readonly line: ToolLine
  // The latest block of a conversation whose agent works: its unanswered calls run.
  readonly live: boolean
}): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const body = useId()
  // The agent works and this call has no result yet.
  const running = live && entry.result === null && entry.tool !== null
  // A result whose call is outside the window is "Result".
  const summary = callRun(entry) ?? { kind: "other", title: "Result", detail: "" }
  const note = toolNote(entry)
  const change = entry.outcome?.change
  const input = entry.tool === null ? null : inputBeyondLine(entry.input, summary)
  const call = input !== null && (
    <Detail
      label={entry.tool === summary.title ? "Call" : `Call: ${entry.tool}`}
      text={input}
      truncated={entry.truncated}
    />
  )
  return (
    <li
      className="chat-tool"
      data-kind={summary.kind}
      data-running={running || undefined}
      data-failed={note?.kind === "failed" || undefined}
    >
      <button
        type="button"
        className="chat-tool-summary nodrag nopan"
        aria-expanded={open}
        aria-controls={open ? body : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="chat-tool-title">
          {shownControls(running ? runningVerb(summary) : verbOf(summary.title))}
        </span>
        {summary.detail && (
          <>
            {" "}
            <span className="chat-tool-detail">{shownControls(summary.detail)}</span>
          </>
        )}
        {/* Kept whole, as the words before it give way on a narrow line. */}
        <span className="chat-tool-end">
          {note && <Note note={note} />}
          {scripted.length > 0 && <> · {counted(scripted.length, "call")}</>}
          <Failed count={failedCount(scripted)} />
          {running && " …"}
          {running && <span className="sr-only">(running)</span>}
        </span>
      </button>
      {open && (
        <div id={body} className="chat-tool-body">
          {change?.lines.length ? (
            <>
              <Changes change={change} />
              {/* What the diff doesn't say: the lines past those carried, or a file the line
                  couldn't name. */}
              {(moreChanged(change) > 0 || summary.detail === "") && call}
            </>
          ) : (
            <>
              {call}
              {entry.result ? (
                <Detail
                  label="Result"
                  text={entry.result.text}
                  truncated={entry.result.truncated}
                />
              ) : (
                <p className="chat-tool-note">{running ? "Running…" : "No result recorded."}</p>
              )}
            </>
          )}
          {scripted.length > 0 && <ToolList entries={scripted} live={live} />}
        </div>
      )}
    </li>
  )
}

const ToolList = ({
  id,
  entries,
  live,
}: {
  readonly id?: string
  readonly entries: readonly ToolEntry[]
  readonly live: boolean
}): React.JSX.Element => (
  <ul id={id} className="chat-tools-list">
    {toolLines(entries).map((line) => (
      <ToolRow key={line.entry.id} line={line} live={live} />
    ))}
  </ul>
)

// Consecutive tool calls, a dim line each. A long run folds into a line that counts them.
export const ToolCalls = ({
  entries,
  live,
}: {
  readonly entries: readonly ToolEntry[]
  // The latest block of a conversation whose agent works: its unanswered calls run.
  readonly live: boolean
}): React.JSX.Element => {
  const folds = toolLines(entries).length >= foldAt
  const [open, setOpen] = useState(live)
  const list = useId()
  const summary = foldSummary(entries)
  if (!folds)
    return (
      <div className="chat-tools">
        <ToolList entries={entries} live={live} />
      </div>
    )
  return (
    <div className="chat-tools" data-folded={!open}>
      <button
        type="button"
        className="chat-tools-fold nodrag nopan"
        aria-expanded={open}
        aria-controls={open ? list : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="chat-tool-title">{entries.length} tool calls</span>
        {summary && <span className="chat-tool-said"> · {shownControls(summary)}</span>}
        <Failed count={failedCount(entries)} />
      </button>
      {open && <ToolList id={list} entries={entries} live={live} />}
    </div>
  )
}
