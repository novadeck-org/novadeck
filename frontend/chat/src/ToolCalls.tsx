import type { ToolChange } from "@novadeck/core/conversation"
import type { ToolEntry } from "@novadeck/core/conversation/turns"
import { counted } from "@novadeck/core/units"
import { useId, useLayoutEffect, useRef, useState } from "react"

import { Fact, Since, TimeFact } from "./Fact"
import { longMs, span } from "./facts"
import { MoreKey, useFold } from "./fold"
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

// A call's input or what it printed: a long one shows its first lines, as another agent's message
// does, and the key under it the rest.
const Detail = ({
  label,
  text,
  truncated,
}: {
  readonly label: string
  readonly text: string
  readonly truncated: boolean
}): React.JSX.Element => {
  const [ref, fold] = useFold<HTMLPreElement>(text)
  return (
    <section className="chat-tool-part" aria-label={label}>
      <pre ref={ref} id={fold.id} className="nodrag nopan" {...fold.cut}>
        {shownControls(text) || "(empty)"}
      </pre>
      <MoreKey fold={fold} />
      {truncated && <p className="chat-tool-note">Shortened here; the rest isn't carried over.</p>}
    </section>
  )
}

// The lines a call changed, each with its number where the harness records one, and how many
// more it counted.
const Changes = ({ change }: { readonly change: ToolChange }): React.JSX.Element => {
  const more = moreChanged(change)
  return (
    <section className="chat-tool-part" aria-label="Changes">
      {/* Focusable, so a long diff can be scrolled by keyboard. */}
      <pre tabIndex={0} className="chat-changes nodrag nopan nowheel">
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
  // Its clock while it runs, its length once it's done and that was long; else its time, on hover.
  const took =
    entry.at !== null && entry.doneAt !== null && entry.doneAt - entry.at >= longMs
      ? entry.doneAt - entry.at
      : null
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
      {running && entry.at !== null ? (
        <Fact live>
          <Since since={entry.at} />
        </Fact>
      ) : took !== null ? (
        <Fact>{span(took)}</Fact>
      ) : (
        <TimeFact at={entry.at} hover />
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

// An open run of more lines than this shows that many in a box that scrolls, the latest in view.
const boxedAt = 5

// The calls a box holds out of its view, above it and below it.
type OutOfView = { readonly above: number; readonly below: number }

const noneOut: OutOfView = { above: 0, below: 0 }

// The calls of the lines wholly out of the box's view, by where each line is drawn, whatever its
// height: `calls` holds each line's count, its own call and those it scripted. Nothing, where the
// box isn't laid out.
const outOfView = (element: HTMLElement, calls: readonly number[]): OutOfView => {
  if (element.clientHeight === 0) return noneOut
  const top = element.scrollTop
  const bottom = top + element.clientHeight
  const rows = Array.from(element.querySelectorAll<HTMLElement>(":scope > ul > li"))
  return rows.reduce<OutOfView>((out, row, at) => {
    const count = calls[at] ?? 1
    if (row.offsetTop + row.offsetHeight <= top + 1) return { ...out, above: out.above + count }
    if (row.offsetTop >= bottom - 1) return { ...out, below: out.below + count }
    return out
  }, noneOut)
}

// How much taller than a line each its lines are drawn, together: what the person opened of them.
const openedHeight = (list: HTMLElement, rows: number): number => {
  const line = parseFloat(getComputedStyle(list).lineHeight)
  return line > 0 ? Math.max(0, list.offsetHeight - rows * line) : 0
}

// The counts to keep: the last where they're the same, so a scroll that changes none draws nothing
// again.
const sameOut =
  (next: OutOfView) =>
  (last: OutOfView): OutOfView =>
    last.above === next.above && last.below === next.below ? last : next

// What the hint over a long run says: the calls on the side it stands, where some are; else those
// below, the person having scrolled up past them; else that the run opens whole.
const hintOf = ({ above, below }: OutOfView, calls: number): string =>
  above > 0
    ? `… ${counted(above, "earlier call")}`
    : below > 0
      ? `… ${counted(below, "later call")}`
      : `show all ${counted(calls, "call")}`

// An open run's lines. A long run keeps to a box of `boxedAt` lines that follows its latest call,
// as the log follows the latest turn: scrolling up to an earlier one lets go, and back to the end
// follows again. A line opened in it makes the box that much taller, so nothing in it moves. Over
// it, on the side of the lines it hides, a hint counts their calls and shows the run whole, as a
// long message's does.
const RunBox = ({
  id,
  entries,
  live,
}: {
  readonly id: string
  readonly entries: readonly ToolEntry[]
  readonly live: boolean
}): React.JSX.Element => {
  const lines = toolLines(entries)
  const calls = lines.map(({ scripted }) => 1 + scripted.length)
  const boxed = lines.length > boxedAt
  const [whole, setWhole] = useState(false)
  const [out, setOut] = useState(noneOut)
  // How much taller than a line each its opened lines are, which the box grows by.
  const [opened, setOpened] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const capped = boxed && !whole
  // Each line's calls, as one value: a new call, or one scripted into a line, changes it.
  const callsKey = calls.join(",")
  useLayoutEffect(() => {
    const element = box.current
    const list = element?.firstElementChild
    if (!element || !(list instanceof HTMLElement) || !capped) return
    const measure = (): void => setOpened(openedHeight(list, list.children.length))
    measure()
    if (typeof ResizeObserver === "undefined") return
    const watch = new ResizeObserver(measure)
    watch.observe(list)
    return () => watch.disconnect()
  }, [capped])
  useLayoutEffect(() => {
    const element = box.current
    if (!element || !capped) return
    // A line the person opened stays where they read it.
    if (following.current && !element.querySelector('[aria-expanded="true"]'))
      element.scrollTop = element.scrollHeight
    setOut(sameOut(outOfView(element, callsKey.split(",").map(Number))))
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A line opened moves the rest.
  }, [callsKey, capped, opened])
  return (
    <>
      {/* Above the box, where the lines it follows past are. */}
      {boxed && (
        <button
          type="button"
          className="chat-key chat-more chat-tools-whole nodrag nopan"
          aria-expanded={whole}
          aria-controls={id}
          onClick={() => {
            // Boxed again, it's back at the latest call.
            following.current = true
            setWhole(!whole)
          }}
        >
          {whole ? "show less" : hintOf(out, entries.length)}
        </button>
      )}
      <div
        ref={box}
        className="chat-tools-box nodrag nopan nowheel"
        data-capped={capped || undefined}
        data-earlier={(capped && out.above > 0) || undefined}
        style={capped ? ({ "--_opened": `${opened}px` } as React.CSSProperties) : undefined}
        onScroll={(event) => {
          const { scrollTop, scrollHeight, clientHeight } = event.currentTarget
          following.current = scrollHeight - scrollTop - clientHeight < 2
          setOut(sameOut(outOfView(event.currentTarget, calls)))
        }}
      >
        <ToolList id={id} entries={entries} live={live} />
      </div>
    </>
  )
}

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
      {open && <RunBox id={list} entries={entries} live={live} />}
    </div>
  )
}
