import { shellStateOf, type ShellState } from "@novadeck/core/agents/shells"
import type { ShellEntry, ShellsContent } from "@novadeck/core/items"
import { useEffect, useRef, useState } from "react"

import { ArtifactMeta } from "../../ArtifactViewer"
import { useTell } from "../../homes/terminal/tell"
import type { ViewProps } from "../../registration"
import { useContent, useUnfolded } from "../../store/use-item-store"
import {
  missingText,
  orderedShells,
  plain,
  shownLines,
  stateText,
  summaryOf,
  tellText,
} from "./shells"

// A terminal's agent's background shells in the pane, each a row: how it stands, its command,
// and the end of its output, live. One row unfolds to its whole tail while the others fold to
// their last line, and a running one follows its end until the person pauses it. A failed row
// is tinted and offers to tell the agent, drafting into the chat's box.

// The clock of the running shells' times: it ticks only while one runs.
const useNow = (live: boolean): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [live])
  return now
}

const pointedAtEnd = (box: HTMLElement): boolean =>
  box.scrollHeight - box.scrollTop - box.clientHeight < 8

const Log = ({
  shell,
  mode,
  paused,
  onPause,
  agent,
}: {
  shell: ShellEntry
  mode: "open" | "folded" | "beside"
  paused: boolean
  onPause: () => void
  agent: string
}): React.JSX.Element => {
  const box = useRef<HTMLDivElement>(null)
  const { output } = shell
  const follows = mode === "open" && shell.exit === null && !paused
  // The end of a running shell's tail stays in view as it grows.
  useEffect(() => {
    if (follows && output.state === "ready" && box.current)
      box.current.scrollTop = box.current.scrollHeight
  }, [follows, output])
  if (output.state !== "ready") return <p className="shells-note">{missingText(output, agent)}</p>
  if (output.lines.length === 0) return <p className="shells-note">No output yet.</p>
  const shown = shownLines(output.lines, output.firstLine, mode)
  return (
    <>
      {mode === "open" && output.firstLine > 1 && (
        <p className="shells-earlier">The first {output.firstLine - 1} lines aren't shown.</p>
      )}
      <div
        ref={box}
        className="shells-log"
        aria-label={`Output of ${shell.command}`}
        // Scrolling up from the end is asking to read, not to follow.
        onScroll={(event) => {
          if (mode === "open" && !paused && !pointedAtEnd(event.currentTarget)) onPause()
        }}
      >
        {shown.lines.map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- A line's number is its place in the tail, which never reorders.
          <div className="shells-line" key={shown.firstLine + index}>
            <span className="shells-num" aria-hidden>
              {shown.firstLine + index}
            </span>
            <span className="shells-text">{plain(line)}</span>
          </div>
        ))}
      </div>
    </>
  )
}

const Row = ({
  shell,
  agent,
  now,
  open,
  beside,
  onToggle,
  tell,
}: {
  shell: ShellEntry
  agent: string
  now: number
  open: boolean
  beside: boolean
  onToggle: () => void
  tell: ((words: string) => void) | undefined
}): React.JSX.Element => {
  const state: ShellState = shellStateOf(shell)
  const [paused, setPaused] = useState(false)
  const [told, setTold] = useState(false)
  const row = useRef<HTMLLIElement>(null)
  // Unfolding, as the chat's shell line does from outside, brings the row into view.
  useEffect(() => {
    if (open) row.current?.scrollIntoView?.({ block: "nearest" })
  }, [open])
  // Unfolding, or folding, starts following again.
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    setPaused(false)
  }
  useEffect(() => {
    if (!told) return
    const timer = setTimeout(() => setTold(false), 1500)
    return () => clearTimeout(timer)
  }, [told])
  const mode = open ? "open" : beside ? "beside" : "folded"
  return (
    <li ref={row} className="shells-row" data-state={state} data-open={open || undefined}>
      <div className="shells-head">
        <button type="button" className="shells-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="shells-dot" data-state={state} aria-hidden />
          <code className="shells-command" title={shell.command}>
            {shell.command}
          </code>
          <span className="shells-state" data-state={state}>
            {stateText(shell, now)}
          </span>
        </button>
        {state === "failed" && tell && (
          <button
            type="button"
            className="artifact-open shells-tell"
            onClick={() => {
              tell(tellText(shell))
              setTold(true)
            }}
          >
            {told ? "Drafted" : `Tell ${agent}`}
          </button>
        )}
      </div>
      <Log
        shell={shell}
        mode={mode}
        paused={paused}
        onPause={() => setPaused(true)}
        agent={agent}
      />
      {open && state === "running" && shell.output.state === "ready" && (
        <div className="shells-foot">
          {paused ? (
            <span>Paused</span>
          ) : (
            <>
              <span className="shells-live" aria-hidden />
              <span>Following the end</span>
            </>
          )}
          <button
            type="button"
            className="artifact-open shells-pause"
            onClick={() => setPaused(!paused)}
          >
            {paused ? "Follow" : "Pause"}
          </button>
        </div>
      )}
    </li>
  )
}

const Body = ({
  item,
  content,
  itemStore,
  actions,
}: Pick<ViewProps, "item" | "itemStore" | "actions"> & {
  content: ShellsContent
}): React.JSX.Element => {
  const tell = useTell()
  const unfolded = useUnfolded(itemStore, item.id)
  const ordered = orderedShells(content.shells)
  const now = useNow(ordered.some((shell) => shell.exit === null))
  const beside = unfolded !== undefined && ordered.some((shell) => shell.id === unfolded)
  return (
    <>
      <ArtifactMeta actions={actions}>
        <span className="shells-title">Background shells of {content.agent}</span>
        <span>{summaryOf(ordered)}</span>
      </ArtifactMeta>
      {ordered.length === 0 ? (
        <div className="artifact-status">{content.agent} has no background shells now.</div>
      ) : (
        <ul className="shells-list">
          {ordered.map((shell) => (
            <Row
              key={shell.id}
              shell={shell}
              agent={content.agent}
              now={now}
              open={unfolded === shell.id}
              beside={beside}
              onToggle={() => itemStore.unfold(item.id, unfolded === shell.id ? null : shell.id)}
              tell={tell}
            />
          ))}
        </ul>
      )}
    </>
  )
}

export const ShellsView = ({ item, itemStore, target, actions }: ViewProps): React.JSX.Element => {
  const load = useContent(itemStore, target, item)
  const content = load?.state === "ready" && load.content.kind === "shells" ? load.content : null
  return (
    <div
      className="artifact-viewer shells-view"
      aria-busy={!content && load?.state !== "unavailable"}
    >
      {content ? (
        <Body item={item} content={content} itemStore={itemStore} actions={actions} />
      ) : load?.state === "unavailable" ? (
        <div className="artifact-status">The shells are gone.</div>
      ) : (
        <div className="artifact-status" />
      )}
    </div>
  )
}
