import type { ChangeFileRun, ItemId } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { highlightLines, languageOf, type HighlightedLine } from "@novadeck/viewers/code"
import type { FileFacts } from "@novadeck/viewers/facts"
import { ChevronDown, ChevronLeft, ChevronUp } from "lucide-react"
import { useEffect, useMemo, useState, type Ref } from "react"

import type { ItemStore } from "../../store/item-store"
import {
  layoutOf,
  totalsOf,
  type Change,
  type Clip,
  type Fold,
  type Layout,
  type Line,
} from "./diff-rows"
import { headParts, summaryParts } from "./labels"
import { segmentsOf } from "./paint"
import { Counts, Parts, startsOf } from "./Parts"
import type { TreeFile } from "./tree"
import { useFileDiff } from "./use-file-diff"

// One file of the change: its row grown into a plain heading (back, its folder and name, its
// lines, and where it is among the files of the selection), a line of what it came to, and the
// changes, each headed by where it sits. Long changes are clipped in the middle and the
// unchanged stretches between changes folded, a click showing either.

// The most lines of a side that are highlighted.
const mostHighlighted = 6_000

type Sides = {
  readonly before: readonly HighlightedLine[] | undefined
  readonly after: readonly HighlightedLine[] | undefined
}

/** The syntax runs of each side of a run's file, once its parser has loaded. */
const useHighlights = (path: string, run: ChangeFileRun | undefined): Sides => {
  const [sides, setSides] = useState<{ run: ChangeFileRun; sides: Sides } | undefined>()
  useEffect(() => {
    const language = languageOf(path)
    if (!run || !language) return
    let live = true
    const side = async (text: string | null) => {
      const lines = text === null ? undefined : text.split("\n")
      if (!lines || lines.length > mostHighlighted) return undefined
      return (await highlightLines(language, lines)) ?? undefined
    }
    Promise.all([side(run.before), side(run.after)]).then(
      ([before, after]) => live && setSides({ run, sides: { before, after } }),
      () => {},
    )
    return () => {
      live = false
    }
  }, [path, run])
  return sides && sides.run === run ? sides.sides : { before: undefined, after: undefined }
}

const signs = { add: "+", remove: "−", context: "" } as const

// A piece is keyed by where its text starts in the line.
const Code = ({
  line,
  runs,
}: {
  line: Line
  runs: HighlightedLine | undefined
}): React.JSX.Element => {
  const pieces = segmentsOf(line.text, runs, line.marks)
  const starts = startsOf(pieces.map((piece) => piece.text))
  return (
    <span className="changes-text">
      {pieces.map((piece, at) => {
        const key = starts[at]
        if (piece.marked)
          return (
            <mark key={key} className={`changes-tok ${piece.classes}`}>
              {piece.text}
            </mark>
          )
        return piece.classes ? (
          <span key={key} className={piece.classes}>
            {piece.text}
          </span>
        ) : (
          piece.text
        )
      })}
    </span>
  )
}

/** What names a line among those of a change. */
const lineKey = (line: Line): string => `${line.old ?? "-"}:${line.now ?? "-"}:${line.kind}`

const Row = ({ line, sides }: { line: Line; sides: Sides }): React.JSX.Element => {
  const side = line.kind === "remove" ? sides.before : sides.after
  const number = line.kind === "remove" ? line.old : line.now
  return (
    <div className="changes-row" data-kind={line.kind}>
      <span className="changes-num">{number}</span>
      <span className="changes-sign" aria-hidden="true">
        {signs[line.kind]}
      </span>
      <Code line={line} runs={number === null ? undefined : side?.[number - 1]} />
    </div>
  )
}

const ClipRow = ({ clip, onShow }: { clip: Clip; onShow: () => void }): React.JSX.Element => (
  <button type="button" className="changes-clip" onClick={onShow}>
    <span>
      {clip.added + clip.removed} more changed {clip.added + clip.removed === 1 ? "line" : "lines"}
    </span>
    <span className="changes-clip-pm">
      +{clip.added} −{clip.removed}
    </span>
    <span className="changes-clip-show">Show</span>
  </button>
)

const FoldRow = ({
  fold,
  onShow,
}: {
  fold: Fold
  onShow: (() => void) | undefined
}): React.JSX.Element =>
  onShow ? (
    <button type="button" className="changes-fold" onClick={onShow}>
      {fold.count} unchanged {fold.count === 1 ? "line" : "lines"}
    </button>
  ) : (
    <div className="changes-fold" data-still>
      {fold.count} unchanged {fold.count === 1 ? "line" : "lines"}
    </div>
  )

const ChangeBlock = ({
  change,
  sides,
  shown,
  onShow,
}: {
  change: Change
  sides: Sides
  shown: boolean
  onShow: () => void
}): React.JSX.Element => {
  const head = headParts(change.index, change.total, change.fact, change.lines, change.onlyRemoves)
  return (
    <section className="changes-block" aria-label={`Change ${change.index + 1} of ${change.total}`}>
      <header className="changes-hunk-head">
        {head.n && <span className="changes-hunk-n">{head.n}</span>}
        {head.place.length > 0 && (
          <span className="changes-scope">
            <Parts parts={head.place} />
          </span>
        )}
        <span className="changes-where">{head.where}</span>
      </header>
      {change.rows.map((row) =>
        row.kind === "clip" ? (
          shown ? (
            row.hidden.map((line) => <Row key={lineKey(line)} line={line} sides={sides} />)
          ) : (
            <ClipRow key="clip" clip={row} onShow={onShow} />
          )
        ) : (
          <Row key={lineKey(row)} line={row} sides={sides} />
        ),
      )}
    </section>
  )
}

const RunBody = ({
  run,
  facts,
  path,
}: {
  run: ChangeFileRun
  facts: FileFacts | null
  path: string
}): React.JSX.Element => {
  const layout: Layout = useMemo(() => layoutOf(run, run.after, facts), [run, facts])
  const sides = useHighlights(path, run)
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const open = (id: string) => setOpened((now) => new Set(now).add(id))
  return (
    <div className="changes-run">
      {layout.map((piece) => {
        if (piece.kind === "fold") {
          if (opened.has(piece.id) && piece.lines)
            return piece.lines.map((line) => (
              <Row key={`${piece.id}-${line.now}`} line={line} sides={sides} />
            ))
          return (
            <FoldRow
              key={piece.id}
              fold={piece}
              onShow={piece.lines ? () => open(piece.id) : undefined}
            />
          )
        }
        return (
          <ChangeBlock
            key={piece.id}
            change={piece}
            sides={sides}
            shown={opened.has(piece.id)}
            onShow={() => open(piece.id)}
          />
        )
      })}
    </div>
  )
}

export const FileView = ({
  file,
  index,
  total,
  selectionName,
  itemStore,
  target,
  itemId,
  stamp,
  layers,
  headRef,
  onBack,
  onStep,
}: {
  file: TreeFile
  index: number
  total: number
  /** What the selection is, unless it is everything. */
  selectionName: string | undefined
  itemStore: ItemStore
  target: WorkspaceTarget
  itemId: ItemId
  stamp: string
  layers: readonly string[]
  headRef: Ref<HTMLElement>
  onBack: () => void
  onStep: (delta: number) => void
}): React.JSX.Element => {
  const loaded = useFileDiff(itemStore, target, itemId, stamp, file.path, layers)
  const layouts = useMemo(
    () =>
      loaded.state === "ready"
        ? loaded.diff.runs.map((run, at) => layoutOf(run, run.after, loaded.facts[at] ?? null))
        : [],
    [loaded],
  )
  const sum = layouts.reduce(
    (all, layout) => {
      const part = totalsOf(layout)
      return {
        added: all.added + part.added,
        removed: all.removed + part.removed,
        reindented: all.reindented + part.reindented,
      }
    },
    { added: 0, removed: 0, reindented: 0 },
  )
  const counts = loaded.state === "ready" && layouts.length > 0 ? sum : file
  const runs = loaded.state === "ready" ? loaded.diff.runs : []
  const first = runs[0]?.file
  const notice =
    file.secret || first?.secret
      ? "This file may hold secrets, so its changes aren't shown."
      : file.binary || first?.binary
        ? "A binary file: there are no lines to show."
        : loaded.state === "failed"
          ? "Can't read this file's changes."
          : loaded.state === "ready" && runs.some((run) => run.badName)
            ? "This file's name isn't valid text, so its changes can't be asked of git."
            : loaded.state === "ready" && runs.some((run) => run.big)
              ? "This change is too large to show here."
              : loaded.state === "ready" && runs.length === 0
                ? "The layers selected did not change this file."
                : undefined
  const summaries =
    loaded.state === "ready" && !notice
      ? runs.map((run, at) => ({
          parts: summaryParts(
            loaded.facts[at] ?? null,
            run.file,
            layouts[at]?.filter((each) => each.kind === "change").length ?? 0,
          ),
        }))
      : []
  const renamed = first?.oldPath ?? file.oldPath
  return (
    <div className="changes-view changes-file-view" data-path={file.path}>
      <header className="changes-head" ref={headRef} data-kind={file.status}>
        <button
          type="button"
          className="icon-button changes-back"
          aria-label="Back to the files"
          onClick={onBack}
        >
          <ChevronLeft size={16} strokeWidth={1.5} />
        </button>
        <span className="changes-crumbs">
          {file.dir && <span className="changes-dir">{file.dir}/</span>}
          <span className="changes-name">{file.name}</span>
          {selectionName && <span className="changes-in">in {selectionName}</span>}
        </span>
        <Counts
          added={counts.added}
          removed={counts.removed}
          reindented={counts.reindented}
          className="changes-pm changes-head-pm"
        />
        <span className="changes-steps">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous file"
            disabled={index === 0}
            onClick={() => onStep(-1)}
          >
            <ChevronUp size={14} strokeWidth={1.5} />
          </button>
          <span className="changes-of">
            {index + 1} of {total}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="Next file"
            disabled={index === total - 1}
            onClick={() => onStep(1)}
          >
            <ChevronDown size={14} strokeWidth={1.5} />
          </button>
        </span>
      </header>
      <div className="changes-summary">
        {renamed && file.status === "renamed" && (
          <div>
            renamed from <code>{renamed}</code>
          </div>
        )}
        {notice ? (
          <div>{notice}</div>
        ) : loaded.state === "loading" || loaded.state === "idle" ? (
          <div>Reading the changes…</div>
        ) : (
          summaries.map((summary) => (
            <div key={summary.parts.length}>
              <Parts parts={summary.parts} />
            </div>
          ))
        )}
      </div>
      <div className="changes-body">
        {!notice &&
          runs.map((run, at) => (
            <RunBody
              key={run.layers.join(",")}
              run={run}
              facts={loaded.state === "ready" ? (loaded.facts[at] ?? null) : null}
              path={file.path}
            />
          ))}
      </div>
      <div className="changes-hint">
        <kbd>Esc</kbd> back to the files · <kbd>J</kbd> <kbd>K</kbd> next and previous file
      </div>
    </div>
  )
}
