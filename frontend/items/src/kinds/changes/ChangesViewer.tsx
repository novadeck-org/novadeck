import type { PullRequest } from "@novadeck/core/forges"
import { type ChangesContent, type Item } from "@novadeck/core/items"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { ChevronsDownUp, ChevronsUpDown, GitPullRequest } from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"

import type { ArtifactBodyProps } from "../../ArtifactViewer"
import { PaneTools, usePaneNote } from "../../pane-row"
import { Expanded } from "./Expanded"
import { FileTree } from "./FileTree"
import { FileView } from "./FileView"
import { LayerList } from "./LayerList"
import { collapseFrom, expandFrom, placesIn } from "./motion"
import { originNote } from "./origin-note"
import { usePullRequest } from "./pull-requests"
import { alone, idsOf, pick, selectedOf, selectionName } from "./selection"
import { filesOf, filesOfRange, rowsOf } from "./tree"
import { useDrillDown } from "./use-drill-down"
import { useRange } from "./use-range"
import { useChangesView } from "./view-state"

// An agent's change, measured against main: its layers (the uncommitted work and each commit
// since the merge base) to pick from, the files they changed as a tree, and one file at a time
// opened into its changes, or the tree expanded into every file's changes one after another; or a compare an agent showed, a head's commits since it left a base,
// which has no uncommitted work. Read-only. What was picked and opened is kept by item; the files read
// are the backend's, kept until each changes again.

const noun = (count: number): string => `${count} ${count === 1 ? "file" : "files"}`

const stateWords: Readonly<Record<PullRequest["state"], string>> = {
  draft: "draft",
  open: "open",
  merged: "merged",
  closed: "closed",
}

// The work's pull request, a small chip in the row that opens it in the browser: "#812". Only a
// web page's address is linked.
const PullRequestLink = ({ pull }: { pull: PullRequest }): React.JSX.Element | null =>
  /^https?:\/\//i.test(pull.url) ? (
    <a
      className="artifact-open changes-pull"
      href={pull.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`PR #${pull.number}, ${stateWords[pull.state]}, opens in browser`}
    >
      <GitPullRequest size={12} aria-hidden="true" />#{pull.number}
    </a>
  ) : null

// What the whole change comes to, from its own list of files (the net against main).
const sums = (
  content: ChangesContent,
): { files: number; added: number; removed: number; reindented: number } => ({
  files: content.files.length,
  added: content.files.reduce((sum, file) => sum + file.added, 0),
  removed: content.files.reduce((sum, file) => sum + file.removed, 0),
  reindented: content.files.reduce((sum, file) => sum + file.reindented, 0),
})

// The time, read again every minute, as the age of a fetch is said to the minute.
const useMinute = (): number => {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export const ChangesViewer = ({
  item,
  content,
  stamp,
  target,
  itemStore,
}: ArtifactBodyProps<"changes">): React.JSX.Element => {
  const [view, update] = useChangesView(itemStore, item.id)
  // What the files' diffs are read at: the content's stamp, kept where only the files
  // read changed, so marking one read does not read the open file's diff again.
  const shape = useMemo(() => JSON.stringify({ ...content, read: [] }), [content])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- The stamp of the shape's first sight.
  const diffStamp = useMemo(() => stamp, [shape])
  const ids = useMemo(() => idsOf(content.layers), [content.layers])
  const selected = useMemo(() => selectedOf(ids, view.picked), [ids, view.picked])
  const layers = useMemo(() => ids.filter((id) => selected.has(id)), [ids, selected])
  // All the layers are the change as a whole, whose files the content carries; a range of two or
  // more (a Shift+click) is listed by git when asked; until it answers, or where the backend
  // can't, and for one layer, the layers' files added up.
  const whole = layers.length === ids.length
  const ranged = useRange(itemStore, target, item.id, diffStamp, whole ? [] : layers)
  const files = useMemo(
    () =>
      whole
        ? filesOfRange(content.files, content.layers, layers)
        : ranged
          ? filesOfRange(ranged.files, content.layers, layers)
          : filesOf(content.layers, selected),
    [whole, ranged, layers, content.files, content.layers, selected],
  )
  const rows = useMemo(() => rowsOf(files), [files])
  // The files in the order the tree shows them, which J and K step through.
  const order = useMemo(
    () => rows.flatMap((row) => (row.kind === "file" ? [row.file] : [])),
    [rows],
  )
  const all = useMemo(() => sums(content), [content])
  const minute = useMinute()
  const note = originNote(content.origin, minute)
  const worktreePull = usePullRequest(content.root)
  // A compare is of the refs the agent named, not the checkout's work: its pull request isn't.
  const pull = content.head === undefined ? worktreePull : undefined
  // What the tab's tooltip says of the change, which the row's header used to: its base, and what
  // the whole change comes to.
  usePaneNote([
    `against ${content.base}`,
    all.files === 0
      ? "no changes"
      : `${noun(all.files)}${content.truncated ? ", more than shown" : ""} · +${all.added} −${all.removed}${all.reindented > 0 ? ` ${all.reindented} re-indented` : ""}`,
    // How current a compare's remote refs are, where that is in doubt, and why a fetch failed.
    ...(note ? [note.title === undefined ? note.text : `${note.text}: ${note.title}`] : []),
  ])

  // A file opened is read: grayed at once, until the content comes again with the backend's word.
  const markRead = useCallback(
    (path: string) => {
      update((now) => ({
        ...now,
        read: {
          ...Object.fromEntries(Object.entries(now.read).filter(([, at]) => at === stamp)),
          [path]: stamp,
        },
      }))
      itemStore.changeRead(target, item.id, path)
    },
    [item.id, itemStore, stamp, target, update],
  )
  const read = useMemo(
    () =>
      new Set([
        ...content.read,
        ...Object.entries(view.read).flatMap(([path, at]) => (at === stamp ? [path] : [])),
      ]),
    [content.read, stamp, view.read],
  )

  const { host, head, list, phase, opened, open, back, step } = useDrillDown(
    order,
    view,
    update,
    markRead,
  )
  // The tree expanded into every file's diff, and back: the file at the top stays at the top, and
  // each row in view grows into its heading (or its heading settles back into its row).
  const expanded = view.expanded && order.length > 0
  const scroller = useRef<HTMLDivElement>(null)
  const moving = useRef<{
    kind: "expand" | "collapse"
    from: Map<string, DOMRect>
    top: string | undefined
  } | null>(null)
  const setExpanded = useCallback(
    (next: boolean) => {
      const box = scroller.current
      if (box) {
        const from = placesIn(box, next ? ".diff-file" : ".changes-stack-head")
        moving.current = { kind: next ? "expand" : "collapse", from, top: from.keys().next().value }
      }
      update((now) => ({ ...now, expanded: next }))
    },
    [update],
  )
  useLayoutEffect(() => {
    const move = moving.current
    const box = scroller.current
    moving.current = null
    if (!move || !box) return
    const anchor =
      move.top === undefined
        ? undefined
        : [...box.querySelectorAll<HTMLElement>("[data-path]")].find(
            (each) =>
              each.dataset.path === move.top &&
              each.matches(move.kind === "expand" ? ".changes-stack-file" : ".diff-file"),
          )
    const was = move.top === undefined ? undefined : move.from.get(move.top)
    box.scrollTop = 0
    if (anchor && was)
      box.scrollTop =
        anchor.getBoundingClientRect().top - Math.max(was.top, box.getBoundingClientRect().top)
    if (move.kind === "expand") expandFrom(box, move.from)
    else collapseFrom(box, move.from)
  }, [expanded])
  const shutFile = useCallback(
    (path: string) =>
      update((now) => ({
        ...now,
        shut: now.shut.includes(path)
          ? now.shut.filter((each) => each !== path)
          : [...now.shut, path],
      })),
    [update],
  )
  const seeFile = useCallback(
    (path: string) => {
      if (!read.has(path)) markRead(path)
    },
    [markRead, read],
  )
  // J and K step to the next file's heading, or back to this one's, then the one before.
  const jump = (delta: number) => {
    const box = scroller.current
    if (!box) return
    const top = box.getBoundingClientRect().top
    const sections = [...box.querySelectorAll<HTMLElement>(".changes-stack-file")]
    const at = sections.findIndex((each) => each.getBoundingClientRect().bottom > top + 41)
    if (at < 0) return
    const here = sections[at]!.getBoundingClientRect().top
    const to =
      delta < 0 && here < top - 1
        ? sections[at]
        : sections[Math.min(Math.max(at + delta, 0), sections.length - 1)]
    if (to) box.scrollTop += to.getBoundingClientRect().top - top
  }

  const unfolded = order.some((file) => file.path === view.unfolded) ? view.unfolded : null

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(opened || expanded) || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === "Escape") {
      if (opened) back()
      else setExpanded(false)
    } else if (event.key === "j" || event.key === "J") {
      if (opened) step(1)
      else jump(1)
    } else if (event.key === "k" || event.key === "K") {
      if (opened) step(-1)
      else jump(-1)
    } else return
    event.preventDefault()
    event.stopPropagation()
  }

  const name = selectionName(content.layers, selected)
  const index = opened ? order.indexOf(opened) : -1
  const file = opened ?? (phase?.kind === "closing" ? phase.file : undefined)
  const listing = !opened || phase !== null
  const filing = file !== undefined && (opened !== undefined || phase?.kind === "closing")

  return (
    <>
      <PaneTools
        chip={
          pull ? (
            <PullRequestLink pull={pull} />
          ) : (
            note && (
              // A compare has no pull request: where its remote refs may be old, the row says so.
              <span
                className="changes-origin"
                data-stale={note.stale || undefined}
                title={note.title}
              >
                {note.text}
                {note.title !== undefined && (
                  // The reason, for those who can't hover to read the title.
                  <span className="changes-origin-why">: {note.title}</span>
                )}
              </span>
            )
          )
        }
        tools={[]}
      />
      <div
        ref={host}
        className="changes-host"
        tabIndex={-1}
        // A pane over its terminal leaves the keys to a file that takes them.
        data-pane-keys={opened || expanded ? "" : undefined}
        data-moving={phase?.kind}
        onKeyDown={keys}
        // A click on the file takes the keys, which a terminal beside it may have taken.
        onMouseDown={(event) => {
          if ((opened || expanded) && !(event.target as Element).closest("button"))
            host.current?.focus({ preventScroll: true })
        }}
      >
        {listing && (
          <div
            ref={list}
            className="changes-view changes-list-view"
            data-leaving={phase?.kind === "opening" || undefined}
          >
            {content.layers.length === 0 ? (
              <div className="diff-empty">
                {content.base.endsWith("(no commits yet)")
                  ? "No commits yet, so there is nothing to compare."
                  : `No changes against ${content.base}.`}
              </div>
            ) : (
              <>
                <LayerList
                  layers={content.layers}
                  selected={selected}
                  only={alone(ids, view.picked)}
                  anchored={view.picked[0] !== undefined && ids.includes(view.picked[0])}
                  onPick={(id, range) =>
                    update((now) => ({ ...now, picked: pick(ids, now.picked, id, range) }))
                  }
                />
                <div className="changes-files-head">
                  <h3 className="section-label">Files</h3>
                  <span className="changes-files-of">
                    {files.length === 0 ? "" : `${noun(files.length)} · ${name}`}
                  </span>
                  {files.length > 0 && (
                    <Tooltip
                      content={
                        expanded
                          ? "Fold the diffs back into the tree · Esc"
                          : "Show every file's diff, one after another"
                      }
                    >
                      <button
                        type="button"
                        className="changes-expand"
                        aria-keyshortcuts={expanded ? "Escape" : undefined}
                        onClick={() => setExpanded(!expanded)}
                      >
                        {expanded ? (
                          <ChevronsDownUp size={14} strokeWidth={1.6} aria-hidden="true" />
                        ) : (
                          <ChevronsUpDown size={14} strokeWidth={1.6} aria-hidden="true" />
                        )}
                        {expanded ? "Collapse all" : "Expand all"}
                      </button>
                    </Tooltip>
                  )}
                </div>
                <div
                  ref={scroller}
                  className="changes-scroll"
                  data-expanded={expanded || undefined}
                >
                  {files.length === 0 ? (
                    <div className="diff-empty">
                      {all.files === 0
                        ? `No changes against ${content.base}.`
                        : "The layers selected changed no files."}
                    </div>
                  ) : expanded ? (
                    <Expanded
                      files={order}
                      scroller={scroller}
                      read={read}
                      shut={view.shut}
                      selectionName={name === "everything" ? undefined : name}
                      itemStore={itemStore}
                      target={target}
                      itemId={item.id}
                      stamp={diffStamp}
                      layers={layers}
                      onShut={shutFile}
                      onSeen={seeFile}
                    />
                  ) : (
                    <FileTree
                      rows={rows}
                      read={read}
                      unfolded={unfolded}
                      folded={view.folded}
                      onUnfold={(path) =>
                        update((now) => ({ ...now, unfolded: now.unfolded === path ? null : path }))
                      }
                      onOpen={open}
                      onFold={(path) =>
                        update((now) => ({
                          ...now,
                          folded: now.folded.includes(path)
                            ? now.folded.filter((each) => each !== path)
                            : [...now.folded, path],
                        }))
                      }
                      itemStore={itemStore}
                      target={target}
                      itemId={item.id}
                      stamp={diffStamp}
                      layers={layers}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {filing && (
          <FileView
            key={file.path}
            file={file}
            index={
              index < 0
                ? Math.max(
                    0,
                    order.findIndex((each) => each.path === file.path),
                  )
                : index
            }
            total={order.length}
            selectionName={name === "everything" ? undefined : name}
            itemStore={itemStore}
            target={target}
            itemId={item.id}
            stamp={diffStamp}
            layers={layers}
            headRef={head}
            onBack={back}
            onStep={step}
          />
        )}
      </div>
    </>
  )
}

// A change in miniature: how many files and lines it touches, over the first few paths.
// The totals are the item's detail, the change's net against main as the header says them.
export const ChangesThumb = ({
  content,
  item,
}: {
  content: ChangesContent
  item: Item
}): React.JSX.Element => {
  const { files } = sums(content)
  const paths = rowsOf(filesOf(content.layers, new Set(content.layers.map((layer) => layer.id))))
    .flatMap((row) => (row.kind === "file" ? [row.file] : []))
    .slice(0, 5)
  return (
    <code className="peek-changes">
      <span>{files === 0 ? "No changes" : item.detail}</span>
      {paths.map((file) => (
        <span key={file.path} data-status={file.status}>
          {file.path}
        </span>
      ))}
    </code>
  )
}
