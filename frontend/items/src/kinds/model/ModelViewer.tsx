import { bytesText } from "@novadeck/core/command-text"
import type { FilePart, Item, ModelContent, UnavailableReason } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { Progress } from "@novadeck/toolkit/Progress"
import { createKept } from "@novadeck/viewers"
import {
  mountModel,
  type ModelContent as ModelBytes,
  type ModelTrouble,
} from "@novadeck/viewers/model"
import { useEffect, useMemo, useRef, useState } from "react"

import { Unavailable, type ArtifactBodyProps } from "../../ArtifactViewer"
import { raisePaneAction } from "../../pane-actions"
import { usePaneNote } from "../../pane-row"
import { loadParts } from "../../parts/load"
import { useRevealed } from "../../store/use-item-store"
import { useViewerSlot } from "../../ViewerSlot"
import { loadingText } from "../video/format"
import { modelFrame } from "./assets"
import { formatNames, totalOf } from "./ModelBadge"

// The models read for panes and peeks, by item and stamp, up to 256 MB in all: a pane that goes
// and comes back, as a view switch, draws its model again without reading it.
export const kept = createKept<ModelBytes>(256 * 1024 * 1024, (model) =>
  model.files.reduce((all, file) => all + file.bytes.size, model.bytes.size),
)

// Why a file beside a model that the runner listed couldn't be read after all.
const partReason = (
  result: Awaited<ReturnType<typeof loadParts>>,
): Extract<FilePart, { state: "unavailable" }>["reason"] | "unreadable" =>
  result.state === "unavailable" ? result.reason : "unreadable"

export type ModelRead =
  | { readonly state: "ready"; readonly model: ModelBytes }
  | { readonly state: "changed" }
  | { readonly state: "stopped" }
  | { readonly state: "failed" }
  | { readonly state: "unavailable"; readonly reason: UnavailableReason }

/**
 * Reads a model and the files beside it it names, for the stamp it is at: the model's own
 * parts as a PDF's are, then each file's against its own stamp. A file that can't be read after
 * all is told among those refused, and the model drawn without it; the model itself rewritten
 * is `changed`, and read again from its new content.
 */
export const readModel = async ({
  read,
  id,
  content,
  stamp,
  reveal,
  signal,
  progress,
}: {
  readonly read: (
    itemId: Item["id"],
    part: {
      readonly stamp: string
      readonly offset: number
      readonly reveal: string | undefined
      readonly file?: string
    },
  ) => Promise<FilePart>
  readonly id: Item["id"]
  readonly content: ModelContent
  readonly stamp: string
  readonly reveal: string | undefined
  readonly signal: AbortSignal
  readonly progress: (bytes: number) => void
}): Promise<ModelRead> => {
  const model = await loadParts({
    read: (offset) => read(id, { stamp, offset, reveal }),
    size: content.size,
    mime: "application/octet-stream",
    signal,
    progress,
  })
  if (model.state !== "ready") return model
  let before = content.size
  const files: { name: string; bytes: Blob }[] = []
  const refused: { name: string; reason: string }[] = [...content.refused]
  for (const file of content.files) {
    // eslint-disable-next-line no-await-in-loop -- One file after another, as the progress tells.
    const result = await loadParts({
      read: (offset) => read(id, { stamp: file.stamp, offset, reveal: undefined, file: file.name }),
      size: file.size,
      mime: "application/octet-stream",
      signal,
      progress: (bytes) => progress(before + bytes),
    })
    // Written again since it was listed: the content that follows lists it anew.
    if (result.state === "stopped" || result.state === "changed") return result
    if (result.state === "ready") files.push({ name: file.name, bytes: result.blob })
    else refused.push({ name: file.name, reason: partReason(result) })
    before += file.size
  }
  return { state: "ready", model: { format: content.format, bytes: model.blob, files, refused } }
}

// Where a model's bytes stand: in, with the last file's kept while a newer one's are read, so
// it stays in view until the new one is ready; how far a read has got; or why there's nothing.
type Source = {
  readonly model: ModelBytes | undefined
  readonly loaded: number | null
  readonly problem: UnavailableReason | "failed" | "here" | null
}

type Held = {
  readonly key: string
  readonly model: ModelBytes | undefined
  readonly problem: Source["problem"]
}

/** What a model is read as: its item, its stamp and those of the files beside it. */
export const modelKey = (id: string, stamp: string, content: ModelContent): string =>
  `${id}:${stamp}:${content.files.map((file) => file.stamp).join(",")}`

const useSource = ({
  item,
  content,
  stamp,
  itemStore,
  target,
}: ArtifactBodyProps<"model">): Source => {
  const { part } = itemStore
  // The person's yes to a file that may hold secrets, which its parts are read with.
  const reveal = useRevealed(itemStore, item)
  const id = item.id
  const key = modelKey(id, stamp, content)
  // A pane that comes back starts from the bytes read before, which it holds however long
  // they stay kept, and keeps in view while a rewritten file is read.
  const [held, setHeld] = useState<Held | undefined>(() => {
    const model = kept.get(key)
    return model ? { key, model, problem: null } : undefined
  })
  const [progress, setProgress] = useState<{ key: string; loaded: number }>()
  // Where it's read for, which a read in progress takes as it is when it asks.
  const where = useRef<WorkspaceTarget>(target)
  useEffect(() => {
    where.current = target
  })
  useEffect(() => {
    if (!part || kept.get(key)) return
    const stop = new AbortController()
    void readModel({
      read: (itemId, asked) => part(where.current, itemId, asked),
      id,
      content,
      stamp,
      reveal,
      signal: stop.signal,
      progress: (loaded) => setProgress({ key, loaded }),
    }).then((result) => {
      if (stop.signal.aborted || result.state === "stopped") return
      // A file rewritten while it was read: the content that follows reads it again.
      if (result.state === "changed") return setProgress({ key, loaded: 0 })
      if (result.state === "ready") {
        kept.keep(key, result.model)
        return setHeld({ key, model: result.model, problem: null })
      }
      setHeld({
        key,
        model: undefined,
        problem: result.state === "failed" ? "failed" : result.reason,
      })
    })
    return () => stop.abort()
  }, [id, key, stamp, content, reveal, part])
  if (!part) return { model: undefined, loaded: null, problem: "here" }
  if (held?.key === key) return { model: held.model, loaded: null, problem: held.problem }
  // Kept from another pane of it since this one mounted.
  const model = kept.get(key)
  if (model) return { model, loaded: null, problem: null }
  return { model: held?.model, loaded: progress?.key === key ? progress.loaded : 0, problem: null }
}

// The model itself, in the 3D viewer, which keeps its camera and toggles by item. Its frame's
// keys for the pane (Escape, Ctrl+PageDown and Ctrl+PageUp) come out as the pane's actions,
// raised from here for the pane to carry out.
const Drawn = ({ id, name, model }: { id: string; name: string; model: ModelBytes }) => {
  const [trouble, setTrouble] = useState<ModelTrouble | null>(null)
  const element = useRef<HTMLDivElement | null>(null)
  const frame = useMemo(() => modelFrame(), [])
  const { ref } = useViewerSlot(mountModel, {
    id,
    content: model,
    label: name,
    frame,
    onTrouble: setTrouble,
    onAction: (action) => element.current && raisePaneAction(element.current, action),
  })
  return (
    <div
      ref={(node) => {
        element.current = node
        ref(node)
      }}
      className="artifact-model"
      data-trouble={trouble ?? undefined}
    />
  )
}

// A model of a pane, drawn once its bytes are in, and its progress till then.
export const ModelViewer = (props: ArtifactBodyProps<"model">): React.JSX.Element => {
  const { item, content, itemStore } = props
  const { model, loaded, problem } = useSource(props)
  const total = totalOf(content)
  usePaneNote([`${formatNames[content.format]} · ${bytesText(total)}`])
  if (problem === "here" || problem === "failed")
    return (
      <div className="artifact-status" role="alert">
        {problem === "failed"
          ? `${item.name} couldn't be loaded.`
          : `${item.name} can't be shown here.`}
      </div>
    )
  if (problem)
    return (
      <Unavailable
        item={item}
        reason={problem}
        size={content.size}
        onReveal={() => itemStore.reveal(item.id, item.path)}
      />
    )
  return (
    <div className="model-pane" aria-busy={model === undefined}>
      {model !== undefined && (
        // Its camera is kept by the file as well as the item, so a model stepped onto in its
        // folder opens at its own start, not where the last one was turned to.
        <Drawn id={`${item.id}\n${item.path}`} name={item.name} model={model} />
      )}
      {loaded !== null && (
        <div className="model-loading" data-over={model !== undefined || undefined} role="status">
          <p>{loadingText(loaded, total)}</p>
          <Progress label="Loading the model" value={loaded} max={total} />
        </div>
      )}
    </div>
  )
}
