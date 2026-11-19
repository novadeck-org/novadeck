import type { Item, ModelContent } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { Box } from "lucide-react"
import { useEffect, useState } from "react"

import type { ItemStore } from "../../store/item-store"
import { bytesText } from "../video/format"
import { formatNames, kept, modelKey, readModel, totalOf } from "./ModelViewer"
import { madeStill, peekBytes, stillOf } from "./stills"

// How large a peek's still is drawn, square, in pixels: twice a peek's size, for sharp screens.
const stillSize = 256

// A model's peek: a still of it, fitted, once its bytes are read (the pane's, if it read them),
// or, for one past what a peek reads, or till the still is drawn, its badge and size.
export const ModelThumb = ({
  content,
  item,
  itemStore,
  target,
  stamp,
}: {
  readonly content: ModelContent
  readonly item: Item
  readonly itemStore: ItemStore
  readonly target: WorkspaceTarget
  readonly stamp: string
}): React.JSX.Element => {
  const key = modelKey(item.id, stamp, content)
  const total = totalOf(content)
  const [still, setStill] = useState<{ key: string; url: string | null }>()
  const { part } = itemStore
  useEffect(() => {
    if (!part || total > peekBytes) return
    const stop = new AbortController()
    const known = madeStill(key, stillSize)
    void (async () => {
      let url = await known
      if (url === undefined) {
        const held = kept.get(key)
        const read = held
          ? ({ state: "ready", model: held } as const)
          : await readModel({
              read: (itemId, asked) => part(target, itemId, asked),
              id: item.id,
              content,
              stamp,
              reveal: undefined,
              signal: stop.signal,
              progress: () => {},
            })
        if (read.state !== "ready" || stop.signal.aborted) return
        if (!held) kept.keep(key, read.model)
        url = await stillOf(key, read.model, stillSize)
      }
      if (!stop.signal.aborted) setStill({ key, url })
    })()
    return () => stop.abort()
  }, [key, part, total, target, item.id, content, stamp])
  const url = still?.key === key ? still.url : null
  return url ? (
    <img className="peek-model-still" src={url} alt="" />
  ) : (
    <span className="peek-model">
      <Box size={18} strokeWidth={1.5} aria-hidden />
      <span>{formatNames[content.format]}</span>
      <span>{bytesText(total)}</span>
    </span>
  )
}
