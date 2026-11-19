import type { ChangedFile, ItemId } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"

import type { ItemStore } from "../../store/item-store"
import { answersIn, useAnswer } from "./answers"

// The files a selection of more than one layer changed, as git lists them for the range: its
// own counts, a file added and dropped inside it not there, a renamed one a single row. Read
// once for the same item, change and layers (kept by session, as a file's diff is: see
// ./answers.ts), and undefined while it is read or where the backend can't (or failed, which is
// not kept: it is asked again), when the layers' files are added up. `truncated`: more files
// than it lists.

export type Ranged = { readonly files: readonly ChangedFile[]; readonly truncated: boolean }

const ranges = answersIn<Ranged>(64)

export const useRange = (
  itemStore: ItemStore,
  target: WorkspaceTarget,
  itemId: ItemId,
  stamp: string,
  layers: readonly string[],
): Ranged | undefined =>
  useAnswer(
    ranges(itemStore),
    layers.length > 1 ? [itemId, layers.join(",")].join("\0") : null,
    stamp,
    async () => {
      const range = await itemStore.changeRange(target, itemId, layers)
      return { files: range.files, truncated: range.truncated }
    },
  ).value
