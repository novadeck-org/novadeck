import type { ItemId } from "@novadeck/core/items"
import { createKept } from "@novadeck/viewers"
import { useCallback, useReducer } from "react"

// Whether a file with a preview shows it or its source, by the item showing it and the file
// it shows: the person's choice holds while the item's pane is built again, as a view switch
// or a tab brought back does, for the files lately switched. The same item shown another
// file, as the project window's is when the person opens one, opens on that one's preview.
// One never switched shows its preview.

export type FileView = "preview" | "source"

const chosen = createKept<{ readonly path: string; readonly view: FileView }>(64)

export const viewOf = (id: ItemId, path: string): FileView => {
  const saved = chosen.get(id)
  return saved?.path === path ? saved.view : "preview"
}

// The view of item `id` showing `path`, and the switch to the other.
export const useFileView = (
  id: ItemId,
  path: string,
): readonly [FileView, (next: FileView) => void] => {
  const [, redraw] = useReducer((count: number) => count + 1, 0)
  const choose = useCallback(
    (next: FileView) => {
      chosen.keep(id, { path, view: next })
      redraw()
    },
    [id, path],
  )
  return [viewOf(id, path), choose]
}
