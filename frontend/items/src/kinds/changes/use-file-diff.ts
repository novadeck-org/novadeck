import type { ItemId } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { useMemo } from "react"

import type { ItemStore } from "../../store/item-store"
import { useAnswer } from "./answers"
import { diffFamily, fileDiffs, readDiff, type FileDiff } from "./diff-cache"

export type FileDiffState =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | ({ readonly state: "ready" } & FileDiff)

const idle: FileDiffState = { state: "idle" }

/**
 * One file's diff for the layers selected, with its facts, read when `path` is given and not
 * before, and kept (see ./answers.ts): the last one stands while a new stamp's is read.
 * `layers` are the ids selected, newest first.
 */
export const useFileDiff = (
  itemStore: ItemStore,
  target: WorkspaceTarget,
  itemId: ItemId,
  stamp: string,
  path: string | null,
  layers: readonly string[],
): FileDiffState => {
  const { value, failed } = useAnswer(
    fileDiffs(itemStore),
    path === null ? null : diffFamily(itemId, layers, path),
    stamp,
    () => readDiff(() => itemStore.changeFile(target, itemId, path!, layers)),
  )
  const state = useMemo(
    (): FileDiffState =>
      value ? { state: "ready", ...value } : failed ? { state: "failed" } : { state: "loading" },
    [value, failed],
  )
  return path === null ? idle : state
}
