import { trailGone, trailLifeMs, trailOpacity } from "@novadeck/core/files"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { highlightLines, languageOf, type HighlightedLine } from "@novadeck/viewers/code"
import type { FileFacts } from "@novadeck/viewers/facts"
import { Fragment, useCallback, useEffect, useMemo, useState } from "react"

import { Code, signs } from "../FileView"
import { placeParts, type Part } from "../labels"
import { Counts, Parts } from "../Parts"
import { factsOfAgents } from "./facts"
import {
  layoutPreview,
  sourcesOf,
  type Agent,
  type Block,
  type Clash,
  type Cut,
  type Fold,
  type Choice,
  type Row,
  type Stale,
  type View,
} from "./layout"
import { useWrites, type Mark } from "./use-writes"

// A file as it would be once the agents' work merges onto main, in the diff pane's own parts: a
// head of crumbs and counts, a summary that holds the merge set, and each agent's changes as a
// block under a head that names the agent and says what the change is. Read-only. What the
// person leaves out, picks, and unfolds is kept here, so a file's preview opens with everyone
// merged, and stays as it is while the agents write.

// The most lines highlighted.
const mostHighlighted = 6_000

export type { Agent } from "./layout"

// A work that renamed the file to `to` (from the project's folder), by what names it.
export type Rename = { readonly label: string; readonly to: string }

const fresh: View = { left: new Set(), picks: {} }

/** How long ago, as a head says it. */
export const agoText = (at: number, now: number): string => {
  const minutes = Math.floor((now - at) / 60_000)
  if (at <= 0) return ""
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`
}

// The syntax runs of every line the preview may draw, once its parser has loaded.
const useRuns = (
  path: string,
  texts: readonly string[],
): readonly HighlightedLine[] | undefined => {
  const [runs, setRuns] = useState<{
    texts: readonly string[]
    lines: readonly HighlightedLine[]
  }>()
  useEffect(() => {
    const language = languageOf(path)
    if (!language || texts.length > mostHighlighted) return
    let live = true
    highlightLines(language, texts).then(
      (lines) => live && lines && setRuns({ texts, lines }),
      () => {},
    )
    return () => {
      live = false
    }
  }, [path, texts])
  // The runs of the text before stand until the new ones come, so a write does not flash.
  return runs?.lines
}

// What each agent's changes are said to be, as the pane's facts say it: kept from the one
// before while the next is read.
const useFacts = (
  path: string,
  main: string | null,
  agents: readonly Agent[],
): ReadonlyMap<string, FileFacts | null> => {
  const [facts, setFacts] = useState<ReadonlyMap<string, FileFacts | null>>(new Map())
  useEffect(() => {
    let live = true
    factsOfAgents(path, main, agents).then(
      (found) => live && setFacts(found),
      () => {},
    )
    return () => {
      live = false
    }
  }, [path, main, agents])
  return facts
}

// A hollow block fading from a write by the Files panel's own curve, started part-way by a negative
// delay so nothing renders again as time passes; one too old to show keeps its box, hidden.
const Trail = ({ at }: { at: number }): React.JSX.Element => {
  const start = useCallback(
    (element: HTMLSpanElement | null): void => {
      if (!element) return
      const age = Math.max(0, Date.now() - at)
      element.style.visibility = trailOpacity(age) < trailGone ? "hidden" : ""
      element.style.setProperty("--files-trail-delay", `${-age}ms`)
      element.style.setProperty("--files-trail-life", `${trailLifeMs}ms`)
      element.style.setProperty("--files-trail-opacity", String(trailOpacity(age)))
    },
    [at],
  )
  return <span ref={start} className="files-trail" aria-hidden="true" />
}

const MarkView = ({ mark }: { mark: Mark }): React.JSX.Element =>
  mark.cursor ? (
    <span className="files-cursor" aria-hidden="true" />
  ) : (
    <Trail key={mark.at} at={mark.at} />
  )

const Chip = ({ agent }: { agent: Agent }): React.JSX.Element =>
  agent.handle === undefined ? (
    <span className="handle-chip">{agent.label}</span>
  ) : (
    <HandleChip handle={agent.handle} />
  )

type Drawing = {
  readonly runs: readonly HighlightedLine[] | undefined
  readonly pulsing: ReadonlySet<string>
  readonly marked: ReadonlyMap<string, Mark>
  readonly opened: ReadonlySet<string>
  readonly open: (id: string) => void
}

const RowView = ({ row, drawing }: { row: Row; drawing: Drawing }): React.JSX.Element => {
  const mark = row.sig === undefined ? undefined : drawing.marked.get(row.sig)
  return (
    <div
      className="diff-row"
      data-kind={row.kind}
      data-pulse={row.sig !== undefined && drawing.pulsing.has(row.sig) ? "" : undefined}
    >
      <span className="changes-num">{row.n}</span>
      <span className="changes-sign" aria-hidden="true">
        {signs[row.kind]}
      </span>
      <Code line={row} runs={drawing.runs?.[row.src]}>
        {mark && <MarkView mark={mark} />}
      </Code>
    </div>
  )
}

const lines = (count: number): string => `${count} ${count === 1 ? "line" : "lines"}`

const FoldView = ({ fold, drawing }: { fold: Fold; drawing: Drawing }): React.JSX.Element =>
  drawing.opened.has(fold.id) ? (
    <>
      {fold.rows.map((row) => (
        <RowView key={row.n} row={row} drawing={drawing} />
      ))}
    </>
  ) : (
    <button type="button" className="changes-fold" onClick={() => drawing.open(fold.id)}>
      {fold.rows.length} unchanged {fold.rows.length === 1 ? "line" : "lines"}
    </button>
  )

// The lines an agent removed, folded in the remove colour until the person unfolds them.
const CutView = ({ cut, drawing }: { cut: Cut; drawing: Drawing }): React.JSX.Element => {
  const opened = drawing.opened.has(cut.id)
  return (
    <>
      {opened && cut.rows.map((row) => <RowView key={row.n} row={row} drawing={drawing} />)}
      <button
        type="button"
        className="changes-fold preview-cut"
        data-open={opened}
        onClick={() => drawing.open(cut.id)}
      >
        {opened
          ? `fold the ${lines(cut.rows.length)} removed`
          : `${lines(cut.rows.length)} of main removed`}
      </button>
    </>
  )
}

// What a change is, in the pane's words: where it sits, else what it does to which lines.
const placeOf = (block: Block, facts: FileFacts | null | undefined): readonly Part[] => {
  const fact = facts?.changes[block.index]
  if (fact && fact.places.length > 0) return placeParts(fact.places, fact.edit)
  const added = block.rows.filter((row) => !("t" in row)).length
  // The lines of main it changes or removes.
  const touched = block.rows
    .flatMap((row) => ("t" in row ? row.rows : [row]))
    .flatMap((row) => (row.n === null || row.kind === "context" ? [] : [row.n]))
  const span = touched.length === 1 ? `line ${touched[0]}` : `lines ${touched[0]}–${touched.at(-1)}`
  const text =
    touched.length === 0
      ? `adds ${lines(added)}`
      : added === 0
        ? `removes ${span}`
        : `changes ${span}`
  return [{ text, kind: "plain" }]
}

const Picker = ({
  clash,
  onPick,
}: {
  clash: Clash
  onPick: (who: string) => void
}): React.JSX.Element => (
  <span className="preview-picks" role="group" aria-label="Version shown">
    {clash.members.map((member) => (
      <button
        key={member.key}
        type="button"
        className="preview-pick"
        aria-pressed={clash.shown === member}
        onClick={() => onPick(member.key)}
      >
        {member.label}
      </button>
    ))}
    <button
      type="button"
      className="preview-pick"
      aria-pressed={clash.shown === "main"}
      onClick={() => onPick("main")}
    >
      main
    </button>
  </span>
)

const BlockView = ({
  block,
  facts,
  drawing,
  dim,
  writing,
  hiddenMarks,
  now,
  onPick,
}: {
  block: Block
  facts: FileFacts | null | undefined
  drawing: Drawing
  dim: boolean
  // Whether this is the change its agent wrote last while its turn runs.
  writing: boolean
  // The cursors of the clash's hidden agents that are writing, by key.
  hiddenMarks: ReadonlyMap<string, Mark>
  now: number
  onPick: (clash: Clash, who: string) => void
}): React.JSX.Element => {
  const { agent, clash } = block
  const place = block.renamed
    ? ([
        { text: "renamed from ", kind: "word" },
        { text: block.renamed, kind: "code" },
      ] as const)
    : agent
      ? placeOf(block, facts)
      : []
  const hidden = clash?.members.filter((member) => member !== clash.shown) ?? []
  return (
    <section
      className="changes-block"
      data-clash={clash ? "" : undefined}
      data-dim={dim ? "" : undefined}
    >
      <header className="changes-hunk-head">
        <span className="changes-scope">
          {clash && (
            <>
              <span className="preview-clash-word">Clash</span> ·{" "}
              {clash.shown === "main" ? (
                <>main shown</>
              ) : (
                <>
                  <Chip agent={clash.shown} /> shown
                </>
              )}
              ,{" "}
              {hidden.map((member, at) => (
                <Fragment key={member.key}>
                  {at > 0 && ", "}
                  <span className="preview-hidden">
                    <Chip agent={member} />
                    {hiddenMarks.get(member.key) && (
                      <MarkView mark={hiddenMarks.get(member.key)!} />
                    )}
                    's hidden
                  </span>
                </Fragment>
              ))}
              {place.length > 0 && " · "}
            </>
          )}
          {!clash && agent && (
            <>
              <Chip agent={agent} /> ·{" "}
            </>
          )}
          <Parts parts={place} />
        </span>
        {clash ? (
          <Picker clash={clash} onPick={(who) => onPick(clash, who)} />
        ) : (
          <span className="changes-where">
            {writing ? "writing now" : agent ? agoText(agent.changedAt, now) : ""}
          </span>
        )}
      </header>
      {block.rows.map((row) =>
        "t" in row ? (
          <CutView key={row.id} cut={row} drawing={drawing} />
        ) : (
          <RowView key={`${row.kind}:${row.n}:${row.sig ?? ""}`} row={row} drawing={drawing} />
        ),
      )}
    </section>
  )
}

// A change main has rewritten the lines of: the pane's clip in the danger colour, with its
// version a click away, and main's lines under it.
const StaleView = ({ stale, drawing }: { stale: Stale; drawing: Drawing }): React.JSX.Element => {
  const opened = drawing.opened.has(stale.id)
  const span =
    stale.count > 1 ? `lines ${stale.line}–${stale.line + stale.count - 1}` : `line ${stale.line}`
  return (
    <>
      <button
        type="button"
        className="changes-clip preview-stale"
        aria-expanded={opened}
        onClick={() => drawing.open(stale.id)}
      >
        <Chip agent={stale.agent} />
        <span>
          changed {span} before main rewrote {stale.count > 1 ? "them" : "it"}, so it doesn't apply
        </span>
        <span className="changes-clip-show">{opened ? "Hide" : "Show"}</span>
      </button>
      {opened && (
        <section className="changes-block" data-dim="">
          {stale.version.map((row) => (
            <RowView key={row.src} row={row} drawing={drawing} />
          ))}
        </section>
      )}
      {stale.rows.map((row) => (
        <RowView key={row.n} row={row} drawing={drawing} />
      ))}
    </>
  )
}

const noMarks: ReadonlyMap<string, Mark> = new Map()

export const FilePreview = ({
  path,
  main,
  agents,
  lit,
  writing,
  renames,
  onOpen,
}: {
  // The file's path from the project's folder.
  path: string
  // Main's text; null where main has no such file.
  main: string | null
  agents: readonly Agent[]
  // The handles Files lights: emphasis only, never what the preview holds.
  lit: ReadonlySet<string>
  // The handles of the agents writing this file now.
  writing: ReadonlySet<string>
  // The works that renamed this file to another path, and what opens that path's preview.
  renames: readonly Rename[]
  onOpen: (path: string) => void
}): React.JSX.Element => {
  const [view, setView] = useState<View>(fresh)
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const sources = useMemo(() => sourcesOf(main, agents), [main, agents])
  const layout = useMemo(
    () => layoutPreview(main, agents, view, sources),
    [main, agents, view, sources],
  )
  const runs = useRuns(path, sources.texts)
  const facts = useFacts(path, main, agents)
  const { pulsing, marks } = useWrites(agents, writing)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  // Where each agent's mark sits, by line, among the rows shown; the cursors of a clash's
  // hidden agents instead go beside its chip in the head.
  const shown = useMemo(() => {
    const visible = new Set(
      layout.pieces.flatMap((piece) =>
        piece.t === "block"
          ? piece.rows.flatMap((row) => ("t" in row || row.sig === undefined ? [] : [row.sig]))
          : [],
      ),
    )
    const byLine = new Map<string, Mark>()
    const hidden = new Map<string, Mark>()
    for (const [key, mark] of marks)
      if (visible.has(mark.line)) byLine.set(mark.line, mark)
      else if (mark.cursor) hidden.set(key, mark)
    return { byLine, hidden }
  }, [layout, marks])
  // The change an agent wrote last while its turn runs: the one its cursor is in.
  const writingBlocks = useMemo(
    () =>
      new Set(
        layout.pieces.flatMap((piece) =>
          piece.t === "block" && piece.agent
            ? piece.rows.some(
                (row) =>
                  !("t" in row) &&
                  row.sig !== undefined &&
                  marks.get(piece.agent!.key)?.cursor === true &&
                  marks.get(piece.agent!.key)?.line === row.sig,
              )
              ? [piece.id]
              : []
            : [],
        ),
      ),
    [layout, marks],
  )

  const drawing: Drawing = {
    runs,
    pulsing,
    marked: shown.byLine.size > 0 ? shown.byLine : noMarks,
    opened,
    open: (id) =>
      setOpened((was) => {
        const next = new Set(was)
        if (!next.delete(id)) next.add(id)
        return next
      }),
  }
  const pick = (clash: Clash, who: string): void => {
    const seen = Math.max(...clash.members.map((member) => member.changedAt))
    setView((was) => ({
      ...was,
      picks: { ...was.picks, [clash.key]: { who, seen } satisfies Choice },
    }))
  }
  const toggle = (key: string): void =>
    setView((was) => {
      const left = new Set(was.left)
      if (!left.delete(key)) left.add(key)
      return { ...was, left }
    })

  const cut = path.lastIndexOf("/")
  const dir = cut < 0 ? "" : path.slice(0, cut + 1)
  const name = path.slice(cut + 1)
  const doesnt =
    layout.stale === 1 ? "1 change doesn't apply" : `${layout.stale} changes don't apply`
  return (
    <div className="changes-host">
      <div className="changes-view changes-file-view" data-path={path} data-preview="">
        <header className="changes-head" data-kind="modified">
          <span className="changes-crumbs">
            {dir && <span className="changes-dir">{dir}</span>}
            <span className="changes-name">{name}</span>
            <span className="changes-in">preview</span>
          </span>
          <Counts
            added={layout.added}
            removed={layout.removed}
            className="changes-pm changes-head-pm"
          />
        </header>
        <div className="changes-summary">
          <div className="preview-summary">
            <span className="changes-word">main</span>
            {agents.map((agent) => (
              <Fragment key={agent.key}>
                {" + "}
                <button
                  type="button"
                  className="preview-merge"
                  aria-pressed={!view.left.has(agent.key)}
                  title={
                    view.left.has(agent.key)
                      ? `Merge ${agent.label}'s work`
                      : `Leave ${agent.label}'s work out`
                  }
                  onClick={() => toggle(agent.key)}
                >
                  {agent.label}
                </button>
              </Fragment>
            ))}{" "}
            <span className="changes-word">{agents.length > 0 ? "merged" : "as it is"}</span>
            {layout.stale > 0 && (
              <>
                {" · "}
                <span className="preview-stale-count">{doesnt}</span>
              </>
            )}
            {" · read-only"}
          </div>
        </div>
        <div className="changes-body">
          <div className="changes-run">
            {renames.map((rename) => (
              <div key={`${rename.label}\0${rename.to}`} className="changes-clip preview-note">
                <span className="handle-chip">{rename.label}</span>
                <span>
                  renames this file to <code>{rename.to}</code>
                </span>
                <button
                  type="button"
                  className="changes-clip-show"
                  onClick={() => onOpen(rename.to)}
                >
                  Open
                </button>
              </div>
            ))}
            {layout.pieces.map((piece) => {
              switch (piece.t) {
                case "row":
                  return <RowView key={`row:${piece.row.n}`} row={piece.row} drawing={drawing} />
                case "fold":
                  return <FoldView key={piece.id} fold={piece} drawing={drawing} />
                case "stale":
                  return <StaleView key={piece.id} stale={piece} drawing={drawing} />
                case "block":
                  return (
                    <BlockView
                      key={piece.id}
                      block={piece}
                      facts={piece.agent ? facts.get(piece.agent.key) : undefined}
                      drawing={drawing}
                      dim={
                        lit.size > 0 &&
                        !(piece.agent?.handle !== undefined && lit.has(piece.agent.handle))
                      }
                      writing={writingBlocks.has(piece.id)}
                      hiddenMarks={shown.hidden}
                      now={now}
                      onPick={pick}
                    />
                  )
              }
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
