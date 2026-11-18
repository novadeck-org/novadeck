import type { ItemId } from "@novadeck/core/items"
import { createKept } from "@novadeck/viewers"
import { useCallback, useReducer } from "react"

// Whether a file with a preview shows it or its source, by the item showing it: the person's
// choice holds while the item's pane is built again, as a view switch or a tab brought back
// does, for the files lately switched. One never switched shows its preview.

export type FileView = "preview" | "source"

const chosen = createKept<FileView>(64)

export const viewOf = (id: ItemId): FileView => chosen.get(id) ?? "preview"

// The item's view, and the switch to the other.
export const useFileView = (id: ItemId): readonly [FileView, (next: FileView) => void] => {
  const [, redraw] = useReducer((count: number) => count + 1, 0)
  const choose = useCallback(
    (next: FileView) => {
      chosen.keep(id, next)
      redraw()
    },
    [id],
  )
  return [viewOf(id), choose]
}
