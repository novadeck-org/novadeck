import { type ChangesContent, type Item } from "@novadeck/core/items"
import { useCallback, useMemo, type KeyboardEvent } from "react"

import { ArtifactMeta, type ArtifactBodyProps } from "../../ArtifactViewer"
import { FileTree } from "./FileTree"
import { FileView } from "./FileView"
import { LayerList } from "./LayerList"
import { anchored, idsOf, pick, selectedOf, selectionName } from "./selection"
import { filesOf, filesOfRange, rowsOf } from "./tree"
import { useDrillDown } from "./use-drill-down"
import { useRange } from "./use-range"
import { useChangesView } from "./view-state"

// An agent's change, measured against main: its layers (the uncommitted work and each commit
// since the merge base) to pick from, the files they changed as a tree, and one file at a time
// opened into its changes. Read-only. What was picked and opened is kept by item; the files read
// are the backend's, kept until each changes again.

const noun = (count: number): string => `${count} ${count === 1 ? "file" : "files"}`

// What the whole change comes to, from its own list of files (the net against main).
const sums = (
  content: ChangesContent,
): { files: number; added: number; removed: number; reindented: number } => ({
  files: content.files.length,
  added: content.files.reduce((sum, file) => sum + file.added, 0),
  removed: content.files.reduce((sum, file) => sum + file.removed, 0),
  reindented: content.files.reduce((sum, file) => sum + file.reindented, 0),
})

export const ChangesViewer = ({
  item,
  content,
  stamp,
  target,
  itemStore,
  actions,
}: ArtifactBodyProps<"changes">): React.JSX.Element => {
  const [view, update] = useChangesView(itemStore, item.id)
  // What the files' diffs and ranges are read at: the content's stamp, kept where only the files
  // read changed, so marking one read does not read the open file's diff again.
  const shape = useMemo(() => JSON.stringify({ ...content, read: [] }), [content])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- The stamp of the shape's first sight.
  const diffStamp = useMemo(() => stamp, [shape])
  const ids = useMemo(() => idsOf(content.layers), [content.layers])
  const selected = useMemo(() => selectedOf(ids, view.picked), [ids, view.picked])
  const layers = useMemo(() => ids.filter((id) => selected.has(id)), [ids, selected])
  // All the layers are the change as a whole, whose files the content carries; two or more of
  // them are a range git lists when asked; until it answers, or where the backend can't, and
  // for one layer, the layers' files added up.
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
  const unfolded = order.some((file) => file.path === view.unfolded) ? view.unfolded : null

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
            : `${noun(all.files)}${content.truncated ? ", more than shown" : ""} · +${all.added} −${all.removed}${all.reindented > 0 ? ` ${all.reindented} re-indented` : ""} · against ${content.base}`}{" "}
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
                    <div className="diff-empty">
                      {all.files === 0
                        ? `No changes against ${content.base}.`
                        : "The layers selected changed no files."}
                    </div>
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
