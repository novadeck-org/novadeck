import type { ChangedFile, ItemId } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { useEffect, useRef, useState } from "react"

import type { ItemStore } from "../../store/item-store"

// The files a selection of more than one layer changed, as git lists them for the range: its
// own counts, a file added and dropped inside it not there, a renamed one a single row. Read
// once for the same item, change and layers (kept by session, as a file's diff is), and
// undefined while it is read or where the backend can't (or failed, which is not kept: it is
// asked again), when the layers' files are added up. `truncated`: more files than it lists.

export type Ranged = { readonly files: readonly ChangedFile[]; readonly truncated: boolean }

// How many ranges are kept for one session; the oldest go first.
const keptMost = 64

type Cache = { readonly kept: Map<string, Ranged>; readonly asked: Map<string, Promise<Ranged>> }
const caches = new WeakMap<object, Cache>()
const cacheOf = (scope: object): Cache => {
  const known = caches.get(scope)
  if (known) return known
  const made: Cache = { kept: new Map(), asked: new Map() }
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
  // The same item and layers at the stamp before stand while the new stamp's is read, so the
  // counts do not fall back to the layers' added up and snap back.
  const base = [itemId, layers.join(",")].join("\0")
  const last = useRef<{ base: string; value: Ranged } | null>(null)
  const [, setTick] = useState(0)
  const known = layers.length > 1 ? cacheOf(itemStore).kept.get(key) : undefined
  useEffect(() => {
    if (layers.length < 2 || cacheOf(itemStore).kept.has(key)) return
    let live = true
    const { kept, asked } = cacheOf(itemStore)
    // Two views of one question (the selection and everything) share the one run.
    const pending =
      asked.get(key) ??
      itemStore
        .changeRange(target, itemId, layers)
        .then((range): Ranged => {
          const value = { files: range.files, truncated: range.truncated }
          kept.set(key, value)
          for (const old of kept.keys()) {
            if (kept.size <= keptMost) break
            kept.delete(old)
          }
          return value
        })
        .finally(() => asked.delete(key))
    asked.set(key, pending)
    pending.then(
      () => live && setTick((now) => now + 1),
      () => {},
    )
    return () => {
      live = false
    }
    // The key says everything the question depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, itemStore, target])
  if (layers.length < 2) return undefined
  if (known) last.current = { base, value: known }
  return known ?? (last.current?.base === base ? last.current.value : undefined)
}
