import type { ChangedFile, ItemId } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { useEffect, useState } from "react"

import type { ItemStore } from "../../store/item-store"

// The files a selection of more than one layer changed, as git lists them for the range: its
// own counts, a file added and dropped inside it not there, a renamed one a single row. Read
// once for the same item, change and layers (kept by session, as a file's diff is), and
// undefined while it is read or where the backend can't (or failed, which is not kept: it is
// asked again), when the layers' files are added up. `truncated`: more files than it lists.

export type Ranged = { readonly files: readonly ChangedFile[]; readonly truncated: boolean }

// How many ranges are kept for one session; the oldest go first.
const keptMost = 64

type Cache = Map<string, Ranged>
const caches = new WeakMap<object, Cache>()
const cacheOf = (scope: object): Cache => {
  const known = caches.get(scope)
  if (known) return known
  const made: Cache = new Map()
  caches.set(scope, made)
  return made
}

export const useRange = (
  itemStore: ItemStore,
  target: WorkspaceTarget,
  itemId: ItemId,
  stamp: string,
  layers: readonly string[],
): Ranged | undefined => {
  const key = [itemId, stamp, layers.join(",")].join("\0")
  const [, setTick] = useState(0)
  const known = layers.length > 1 ? cacheOf(itemStore).get(key) : undefined
  useEffect(() => {
    if (layers.length < 2 || cacheOf(itemStore).has(key)) return
    let live = true
    itemStore.changeRange(target, itemId, layers).then(
      (range) => {
        const cache = cacheOf(itemStore)
        cache.set(key, { files: range.files, truncated: range.truncated })
        for (const old of cache.keys()) {
          if (cache.size <= keptMost) break
          cache.delete(old)
        }
        if (live) setTick((now) => now + 1)
      },
      () => {},
    )
    return () => {
      live = false
    }
    // The key says everything the question depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, itemStore, target])
  return known
}
