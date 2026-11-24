import type { ChangeFileRun, ItemId } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { highlightLines, languageOf, type HighlightedLine } from "@novadeck/viewers/code"
import { ChevronDown, ChevronLeft, ChevronUp } from "lucide-react"
import { useEffect, useMemo, useState, type Ref } from "react"

import type { ItemStore } from "../../store/item-store"
import {
  layoutFor,
  totalsOf,
  type Change,
  type Clip,
  type Fold,
  type Layout,
  type Line,
} from "./diff-rows"
import { headParts, summaryParts, type Part } from "./labels"
import { segmentsOf, stretchesOf, type Segment } from "./paint"
import { Counts, Parts, startsOf } from "./Parts"
import type { TreeFile } from "./tree"
import { useFileDiff, type FileDiffState } from "./use-file-diff"

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
  // The syntax runs of the run before stand until the new ones come, so a refreshed file does not flash.
  return sides ? sides.sides : { before: undefined, after: undefined }
}

export const signs = { add: "+", remove: "−", context: "" } as const

// A piece is keyed by where its text starts in the line, and a changed run of pieces is one mark,
// keyed by its first. `children` follow the text, as the file preview's cursor does.
export const Code = ({
  line,
  runs,
  children,
}: {
  line: Pick<Line, "text" | "marks">
  runs: HighlightedLine | undefined
  children?: React.ReactNode
}): React.JSX.Element => {
  const pieces = segmentsOf(line.text, runs, line.marks)
  const starts = startsOf(pieces.map((piece) => piece.text))
  const placed = pieces.map((piece, at) => ({ ...piece, key: starts[at] }))
  return (
    <span className="changes-text">
      {stretchesOf(placed).map((stretch) =>
        stretch.marked ? (
          <mark key={stretch.pieces[0]?.key} className="changes-tok">
            {stretch.pieces.map(pieceView)}
          </mark>
        ) : (
          stretch.pieces.map(pieceView)
        ),
      )}
      {children}
    </span>
  )
}

const pieceView = (piece: Segment & { readonly key: number | undefined }): React.ReactNode =>
  piece.classes ? (
    <span key={piece.key} className={piece.classes}>
      {piece.text}
    </span>
  ) : (
    piece.text
  )

/** What names a line among those of a change. */
const lineKey = (line: Line): string => `${line.old ?? "-"}:${line.now ?? "-"}:${line.kind}`

const Row = ({ line, sides }: { line: Line; sides: Sides }): React.JSX.Element => {
  const side = line.kind === "remove" ? sides.before : sides.after
  const number = line.kind === "remove" ? line.old : line.now
  return (
    <div className="diff-row" data-kind={line.kind}>
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

export const RunBody = ({
  run,
  layout,
  path,
}: {
  run: ChangeFileRun
  layout: Layout
  path: string
}): React.JSX.Element => {
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

/** What a file's view shows of its diff as read: the run and its layout, its counts, a notice in
 * place of its lines, a summary, and the name it was renamed from. */
export type FileShown = {
  readonly run: ChangeFileRun | null
  readonly layout: Layout
  readonly counts: { readonly added: number; readonly removed: number; readonly reindented: number }
  readonly notice: string | undefined
  readonly summary: readonly Part[] | undefined
  readonly renamed: string | null | undefined
}

export const useFileShown = (file: TreeFile, loaded: FileDiffState): FileShown => {
  const run = loaded.state === "ready" ? loaded.diff.run : null
  const facts = loaded.state === "ready" ? loaded.facts : null
  const layout = useMemo(() => (run ? layoutFor(run, facts) : []), [run, facts])
  const counts = run ? totalsOf(layout) : file
  const first = run?.file
  const notice =
    file.secret || first?.secret
      ? "This file may hold secrets, so its changes aren't shown."
      : file.binary || first?.binary
        ? "A binary file: there are no lines to show."
        : loaded.state === "failed"
          ? "Can't read this file's changes."
          : loaded.state === "ready" && run?.badName
            ? "This file's name isn't valid text, so its changes can't be asked of git."
            : loaded.state === "ready" && run?.big
              ? "This change is too large to show here."
              : loaded.state === "ready" && !run
                ? "The layers selected did not change this file."
                : undefined
  const summary =
    run && !notice
      ? summaryParts(facts, run.file, layout.filter((each) => each.kind === "change").length)
      : undefined
  const renamed = first?.oldPath ?? file.oldPath
  return { run, layout, counts, notice, summary, renamed }
}

/** The line under a file's heading: where it was renamed from, and what it came to. */
export const FileSummary = ({
  file,
  loaded,
  shown,
}: {
  file: TreeFile
  loaded: FileDiffState
  shown: FileShown
}): React.JSX.Element => (
  <div className="changes-summary">
    {shown.renamed && file.status === "renamed" && (
      <div>
        renamed from <code>{shown.renamed}</code>
      </div>
    )}
    {shown.notice ? (
      <div>{shown.notice}</div>
    ) : loaded.state === "loading" || loaded.state === "idle" ? (
      <div>Reading the changes…</div>
    ) : (
      shown.summary && (
        <div>
          <Parts parts={shown.summary} />
        </div>
      )
    )}
  </div>
)

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
  const shown = useFileShown(file, loaded)
  const { run, layout, counts, notice } = shown
  return (
    <div className="changes-view changes-file-view" data-path={file.path}>
      <header className="changes-head" ref={headRef} data-kind={file.status}>
        <button
          type="button"
          className="icon-button changes-back"
          aria-label="Back to the files"
          aria-keyshortcuts="Escape"
          title="Back to the files · Esc"
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
            aria-keyshortcuts="K"
            title="Previous file · K"
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
            aria-keyshortcuts="J"
            title="Next file · J"
            disabled={index === total - 1}
            onClick={() => onStep(1)}
          >
            <ChevronDown size={14} strokeWidth={1.5} />
          </button>
        </span>
      </header>
      <FileSummary file={file} loaded={loaded} shown={shown} />
      <div className="changes-body">
        {!notice && run && <RunBody run={run} layout={layout} path={file.path} />}
      </div>
    </div>
  )
}
