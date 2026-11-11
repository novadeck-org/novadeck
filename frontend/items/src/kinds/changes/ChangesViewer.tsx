import {
  uncommittedLayer,
  type ChangedFile,
  type ChangesContent,
  type Item,
} from "@novadeck/core/items"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"

import { ArtifactMeta, type ArtifactBodyProps } from "../../ArtifactViewer"
import { FileTree } from "./FileTree"
import { FileView } from "./FileView"
import { LayerList } from "./LayerList"
import { growHeading, motionMs, reducedMotion, returnFiles, shrinkHeading } from "./motion"
import { anchored, idsOf, pick, selectedOf, selectionName } from "./selection"
import { filesOf, filesOfRange, rowsOf, stampOf, type TreeFile } from "./tree"
import { useRange } from "./use-range"
import { useChangesView } from "./view-state"

// An agent's change, measured against main: its layers (the uncommitted work and each commit
// since the merge base) to pick from, the files they changed as a tree, and one file at a time
// opened into its changes. Read-only. What was picked and opened is kept by item.

const noun = (count: number): string => `${count} ${count === 1 ? "file" : "files"}`

const layerName = (id: string): string => (id === uncommittedLayer ? "uncommitted" : id.slice(0, 7))

const sums = (
  content: ChangesContent,
  net?: readonly ChangedFile[],
): { files: number; added: number; removed: number } => {
  const all = new Set(content.layers.map((layer) => layer.id))
  const files = net ?? filesOf(content.layers, all)
  return {
    files: files.length,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  }
}

// Which view is moving to which: the row growing into the heading, or the heading shrinking
// into its row.
type Phase =
  | { readonly kind: "opening"; readonly from: DOMRect }
  | { readonly kind: "closing"; readonly file: TreeFile }

export const ChangesViewer = ({
  item,
  content,
  stamp,
  target,
  itemStore,
  actions,
}: ArtifactBodyProps<"changes">): React.JSX.Element => {
  const [view, update] = useChangesView(itemStore, item.id)
  const ids = useMemo(() => idsOf(content.layers), [content.layers])
  const selected = useMemo(() => selectedOf(ids, view.picked), [ids, view.picked])
  const layers = useMemo(() => ids.filter((id) => selected.has(id)), [ids, selected])
  // The files of a range as git lists them, where there are layers to range over; until they
  // come, or where the backend can't say, the layers' files added up.
  const ranged = useRange(itemStore, target, item.id, stamp, layers)
  const files = useMemo(
    () => (ranged ? filesOfRange(ranged.files, layers) : filesOf(content.layers, selected)),
    [ranged, layers, content.layers, selected],
  )
  const rows = useMemo(() => rowsOf(files), [files])
  // The files in the order the tree shows them, which J and K step through.
  const order = useMemo(
    () => rows.flatMap((row) => (row.kind === "file" ? [row.file] : [])),
    [rows],
  )
  const everyone = useRange(itemStore, target, item.id, stamp, ids)
  const all = useMemo(() => sums(content, everyone?.files), [content, everyone])
  const opened = view.open === null ? undefined : order.find((file) => file.path === view.open)
  const unfolded = order.some((file) => file.path === view.unfolded) ? view.unfolded : null

  const host = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase | null>(null)
  // The path of the file last opened, whose row takes the keys back once its file closes.
  const lastOpened = useRef<string | undefined>(undefined)
  // Where the files were scrolled to when one was opened, which the list is given back.
  const scrolled = useRef(0)

  const rowOf = useCallback(
    (path: string): HTMLElement | null =>
      [...(host.current?.querySelectorAll<HTMLElement>(".changes-file") ?? [])].find(
        (row) => row.dataset.path === path,
      ) ?? null,
    [],
  )

  const open = useCallback(
    (path: string) => {
      const file = order.find((each) => each.path === path)
      if (!file) return
      const from = rowOf(path)?.getBoundingClientRect()
      scrolled.current = host.current?.querySelector<HTMLElement>(".changes-scroll")?.scrollTop ?? 0
      update((now) => ({
        ...now,
        open: path,
        unfolded: path,
        read: { ...now.read, [path]: stampOf(file) },
      }))
      setPhase(from && !reducedMotion() ? { kind: "opening", from } : null)
    },
    [order, rowOf, update],
  )

  const back = useCallback(() => {
    update((now) => ({ ...now, open: null }))
    setPhase(opened && !reducedMotion() ? { kind: "closing", file: opened } : null)
  }, [opened, update])

  const step = useCallback(
    (delta: number) => {
      const at = order.findIndex((file) => file.path === view.open)
      const next = order[at + delta]
      if (!next) return
      update((now) => ({
        ...now,
        open: next.path,
        unfolded: next.path,
        read: { ...now.read, [next.path]: stampOf(next) },
      }))
    },
    [order, update, view.open],
  )

  // The row grows into the heading; the pane takes the keys.
  useLayoutEffect(() => {
    if (phase?.kind !== "opening" || !head.current) return
    const section = head.current.closest<HTMLElement>(".changes-view")
    if (section) growHeading(section, head.current, phase.from)
    const timer = setTimeout(() => setPhase(null), motionMs)
    return () => clearTimeout(timer)
  }, [phase])
  // The files are back where they were scrolled to, before anything is measured.
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    if (!opened && wasOpen.current) {
      const scroller = host.current?.querySelector<HTMLElement>(".changes-scroll")
      if (scroller) scroller.scrollTop = scrolled.current
    }
  }, [opened])
  // The heading shrinks into its row once the files are back.
  useLayoutEffect(() => {
    if (phase?.kind !== "closing") return
    const row = rowOf(phase.file.path)
    const section = head.current?.closest<HTMLElement>(".changes-view")
    if (!row || !head.current || !section) {
      setPhase(null)
      return
    }
    returnFiles(list.current ?? row, row)
    let live = true
    void shrinkHeading(section, head.current, row.getBoundingClientRect()).then(() => {
      if (live) setPhase(null)
    })
    return () => {
      live = false
    }
  }, [phase, rowOf])
  // Keys go to the pane while a file is open, and back to its row once it closes.
  useEffect(() => {
    if (opened) {
      host.current?.focus({ preventScroll: true })
      lastOpened.current = opened.path
    } else if (wasOpen.current && view.open === null) {
      const path = lastOpened.current
      const row = path === undefined ? null : rowOf(path)
      // The row in view, then the keys; a row not drawn (in a folded folder) leaves them to the pane.
      row?.scrollIntoView?.({ block: "nearest" })
      const button = row?.querySelector<HTMLElement>("button")
      ;(button ?? host.current)?.focus({ preventScroll: true })
    }
    wasOpen.current = opened !== undefined
  }, [opened, rowOf, view.open])
  // A file that is no longer among the selection's is no longer open.
  useEffect(() => {
    if (view.open !== null && !opened) update((now) => ({ ...now, open: null }))
  }, [opened, update, view.open])

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!opened || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === "Escape") back()
    else if (event.key === "j" || event.key === "J") step(1)
    else if (event.key === "k" || event.key === "K") step(-1)
    else return
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
      <ArtifactMeta actions={actions}>
        <code className="artifact-meta-name" title={item.name}>
          {item.name}
        </code>
        <span>
          {all.files === 0
            ? `no changes against ${content.base}`
            : `${noun(all.files)}${content.truncated || everyone?.truncated ? ", more than shown" : ""} · +${all.added} −${all.removed} · against ${content.base}`}{" "}
          · read-only
        </span>
      </ArtifactMeta>
      <div
        ref={host}
        className="changes-host"
        tabIndex={-1}
        // A pane over its terminal leaves the keys to a file that takes them.
        data-pane-keys={opened ? "" : undefined}
        data-moving={phase?.kind}
        onKeyDown={keys}
        // A click on the file takes the keys, which a terminal beside it may have taken.
        onMouseDown={(event) => {
          if (opened && !(event.target as Element).closest("button")) host.current?.focus()
        }}
      >
        {listing && (
          <div
            ref={list}
            className="changes-view changes-list-view"
            data-leaving={phase?.kind === "opening" || undefined}
          >
            {content.layers.length === 0 ? (
              <div className="changes-empty">
                {content.base.endsWith("(no commits yet)")
                  ? "No commits yet, so there is nothing to compare."
                  : `No changes against ${content.base}.`}
              </div>
            ) : (
              <>
                <LayerList
                  layers={content.layers}
                  selected={selected}
                  onPick={(id) => update((now) => ({ ...now, picked: pick(ids, now.picked, id) }))}
                />
                <div className="changes-files-head">
                  <h3 className="section-label">Files</h3>
                  <span className="changes-files-of">
                    {files.length === 0 ? "" : `${noun(files.length)} · ${name}`}
                  </span>
                </div>
                <div className="changes-scroll">
                  {files.length === 0 ? (
                    <div className="changes-empty">
                      {all.files === 0
                        ? `No changes against ${content.base}.`
                        : "The layers selected changed no files."}
                    </div>
                  ) : (
                    <FileTree
                      rows={rows}
                      read={view.read}
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
                      stamp={stamp}
                      layers={layers}
                      layerName={layerName}
                    />
                  )}
                </div>
                <div className="changes-hint">
                  {anchored(ids, view.picked)
                    ? "Click another to take everything between"
                    : "Click a commit to see only it"}{" "}
                  · click a file to unfold it · double-click opens it
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
            stamp={stamp}
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
