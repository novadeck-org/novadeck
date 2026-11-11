import type { ItemId } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { useEffect, useMemo, useRef, useState } from "react"

import type { ItemStore } from "../../store/item-store"
import { loadDiff, peekDiff, type FileDiff } from "./diff-cache"

export type FileDiffState =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | ({ readonly state: "ready" } & FileDiff)

/**
 * One file's diff for the layers selected, with its facts, read when `path` is given and not
 * before, and kept (see ./diff-cache.ts). `layers` are the ids selected, newest first.
 */
export const useFileDiff = (
  itemStore: ItemStore,
  target: WorkspaceTarget,
  itemId: ItemId,
  stamp: string,
  path: string | null,
  layers: readonly string[],
): FileDiffState => {
  const key = path === null ? "" : [itemId, stamp, layers.join(","), path].join("\0")
  // What the same file of the same layers last read as, to stand while a new stamp's is read.
  const base = path === null ? "" : [itemId, layers.join(","), path].join("\0")
  const last = useRef<{ base: string; value: FileDiff } | null>(null)
  const [answer, setAnswer] = useState<{ key: string; value: FileDiff | null } | null>(null)
  const cached = path === null ? undefined : peekDiff(itemStore, itemId, stamp, layers, path)
  useEffect(() => {
    if (path === null || cached) return
    let live = true
    loadDiff(itemStore, itemId, stamp, layers, path, () =>
      itemStore.changeFile(target, itemId, path, layers),
    ).then(
      (value) => live && setAnswer({ key, value }),
      () => live && setAnswer({ key, value: null }),
    )
    return () => {
      live = false
    }
    // The key says everything the question depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, itemStore, target])
  const value = cached ?? (answer?.key === key ? answer.value : undefined)
  const stale = value === undefined && last.current?.base === base ? last.current.value : undefined
  const shown = value ?? stale
  const state = useMemo((): FileDiffState => {
    if (shown) return { state: "ready", ...shown }
    return value === null ? { state: "failed" } : { state: "loading" }
  }, [shown, value])
  if (value) last.current = { base, value }
  return path === null ? idle : state
}

const idle: FileDiffState = { state: "idle" }
