import type { ItemId } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { ChevronRight } from "lucide-react"
import { memo, useEffect, useRef, useState, type RefObject } from "react"

import type { ItemStore } from "../../store/item-store"
import { FileSummary, RunBody, useFileShown } from "./FileView"
import { Counts } from "./Parts"
import type { TreeFile } from "./tree"
import { useFileDiff } from "./use-file-diff"

// The tree expanded: every file's diff, one after another in the tree's order, as a file opened
// shows it, under a heading that stays on top while its file scrolls by. A file's diff is read
// as it comes near, so a large change costs only what is looked at; until then its place is
// held by its size. A file whose diff has been on screen is read. A heading's arrow hides its
// file's diff.

// How far past the view a file's diff is read ahead.
const readAhead = "1200px 0px"
// How tall a line is, and the most lines a file not yet read holds a place for.
const lineHeight = 20
// The heading's height, which stays on top.
const headHeight = 40
// How long a file's diff is on screen before it counts as seen: a fling past is not.
const dwellMs = 500
const mostHeld = 400

const ExpandedFileBody = ({
  file,
  near,
  seen,
  shut,
  read,
  selectionName,
  itemStore,
  target,
  itemId,
  stamp,
  layers,
  onShut,
  onSeen,
}: {
  file: TreeFile
  near: boolean
  seen: boolean
  shut: boolean
  read: boolean
  selectionName: string | undefined
  itemStore: ItemStore
  target: WorkspaceTarget
  itemId: ItemId
  stamp: string
  layers: readonly string[]
  onShut: (path: string) => void
  onSeen: (path: string) => void
}): React.JSX.Element => {
  const loaded = useFileDiff(
    itemStore,
    target,
    itemId,
    stamp,
    near && !shut ? file.path : null,
    layers,
  )
  const shown = useFileShown(file, loaded)
  const { run, layout, counts, notice } = shown
  // Its diff, or what stands for it, on screen a moment while the page shows: the file is read,
  // once each time it comes on screen, so a file an agent changes while it is there stays
  // unread until it comes again.
  const shownNow = seen && !shut && (loaded.state === "ready" || notice !== undefined)
  const marked = useRef(false)
  useEffect(() => {
    if (!seen) marked.current = false
  }, [seen])
  useEffect(() => {
    if (!shownNow || read || marked.current) return
    const timer = setTimeout(() => {
      if (document.visibilityState === "hidden") return
      marked.current = true
      onSeen(file.path)
    }, dwellMs)
    return () => clearTimeout(timer)
  }, [file.path, onSeen, read, shownNow])
  const held = loaded.state === "ready" || notice ? undefined : heldHeight(file)
  return (
    <section
      className="changes-stack-file"
      data-path={file.path}
      data-shut={shut || undefined}
      aria-label={file.path}
    >
      <header className="changes-head changes-stack-head" data-kind={file.status}>
        <button
          type="button"
          className="icon-button changes-stack-fold"
          aria-expanded={!shut}
          aria-label={shut ? `Show the diff of ${file.name}` : `Hide the diff of ${file.name}`}
          title={shut ? "Show this file's diff" : "Hide this file's diff"}
          onClick={() => onShut(file.path)}
        >
          <ChevronRight size={14} strokeWidth={1.5} data-open={!shut} />
        </button>
        <span className="changes-crumbs" data-read={read || undefined} title={file.path}>
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
      </header>
      {!shut && (
        <>
          <FileSummary file={file} loaded={loaded} shown={shown} />
          <div className="changes-stack-body" style={held ? { minHeight: held } : undefined}>
            {!notice && run && <RunBody run={run} layout={layout} path={file.path} />}
          </div>
        </>
      )}
    </section>
  )
}

const ExpandedFile = memo(ExpandedFileBody)

// Without a way to tell what is near, every file is, and none is seen.
const canWatch = (): boolean => typeof IntersectionObserver === "function"

/** The room a file not read yet holds: its lines, up to a point. */
const heldHeight = (file: TreeFile): number =>
  Math.min(file.added + file.removed, mostHeld) * lineHeight

export const Expanded = ({
  files,
  scroller,
  read,
  shut,
  selectionName,
  itemStore,
  target,
  itemId,
  stamp,
  layers,
  onShut,
  onSeen,
}: {
  /** The files in the tree's order. */
  files: readonly TreeFile[]
  /** What scrolls them, which says what is near and what is seen. */
  scroller: RefObject<HTMLElement | null>
  read: ReadonlySet<string>
  shut: readonly string[]
  selectionName: string | undefined
  itemStore: ItemStore
  target: WorkspaceTarget
  itemId: ItemId
  stamp: string
  layers: readonly string[]
  onShut: (path: string) => void
  /** A file's diff was on screen. */
  onSeen: (path: string) => void
}): React.JSX.Element => {
  const watchable = canWatch()
  // The files by path, which a content that comes again with the same files keeps.
  const paths = files.map((file) => file.path).join("\n")
  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set())
  const [onScreen, setOnScreen] = useState<ReadonlySet<string>>(() => new Set())
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = scroller.current
    if (!root || !canWatch()) return
    const pathOf = (entry: IntersectionObserverEntry) => (entry.target as HTMLElement).dataset.path
    const ahead = new IntersectionObserver(
      (entries) => {
        const come = entries.flatMap((entry) => {
          const path = entry.isIntersecting ? pathOf(entry) : undefined
          return path === undefined ? [] : [path]
        })
        if (come.length > 0)
          setNear((now) => (come.every((path) => now.has(path)) ? now : new Set([...now, ...come])))
      },
      { root, rootMargin: readAhead },
    )
    // A file's diff on screen past the heading on top: its heading alone is not.
    const screen = new IntersectionObserver(
      (entries) =>
        setOnScreen((now) => {
          const next = new Set(now)
          for (const entry of entries) {
            const path = (entry.target as HTMLElement).closest<HTMLElement>("[data-path]")?.dataset
              .path
            if (path === undefined) continue
            if (entry.isIntersecting) next.add(path)
            else next.delete(path)
          }
          return next.size === now.size && [...next].every((path) => now.has(path)) ? now : next
        }),
      { root, rootMargin: `-${headHeight}px 0px 0px 0px` },
    )
    for (const section of list.current?.querySelectorAll<HTMLElement>(".changes-stack-file") ??
      []) {
      ahead.observe(section)
      const body = section.querySelector(".changes-stack-body")
      if (body) screen.observe(body)
    }
    return () => {
      ahead.disconnect()
      screen.disconnect()
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The bodies drawn are the ones watched.
  }, [paths, shut, scroller])
  return (
    <div ref={list} className="changes-stack" role="list" aria-label="Every file's diff">
      {files.map((file) => (
        <div key={file.path} role="listitem">
          <ExpandedFile
            file={file}
            near={!watchable || near.has(file.path)}
            seen={onScreen.has(file.path)}
            shut={shut.includes(file.path)}
            read={read.has(file.path)}
            selectionName={selectionName}
            itemStore={itemStore}
            target={target}
            itemId={itemId}
            stamp={stamp}
            layers={layers}
            onShut={onShut}
            onSeen={onSeen}
          />
        </div>
      ))}
    </div>
  )
}
