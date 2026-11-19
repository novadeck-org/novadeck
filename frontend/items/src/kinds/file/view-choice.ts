import type { ItemId } from "@novadeck/core/items"
import { createKept } from "@novadeck/viewers"
import { useCallback, useEffect, useReducer } from "react"

// Whether a file with a preview shows it or its source, by the item showing it and the file
// it shows: the person's choice holds while the item's pane is built again, as a view switch
// or a tab brought back does, for the files lately switched. The same item shown another
// file, as the project window's is when the person opens one, opens on that one's preview.
// One never switched shows its preview.

export type FileView = "preview" | "source"

const chosen = createKept<{ readonly path: string; readonly view: FileView }>(64)

// The items asked to open on their source (`openOnSource`) that no viewer has taken up yet, and
// the viewers showing now, which are told when one is asked for. An ask lapses after a while: an
// item that opens as unavailable (too large, binary) or on a file with no preview never takes it
// up, and must not be switched to source by it later, unasked.
const asked = createKept<boolean>(64)
const lapses = new Map<ItemId, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()
const askedFor = 15_000

// Has item `id` show its file's source, as if the person had switched to it: for the file it shows
// now or, if it isn't shown yet, the one it opens on. It is the person's choice from then on.
export const openOnSource = (id: ItemId): void => {
  asked.keep(id, true)
  clearTimeout(lapses.get(id))
  lapses.set(
    id,
    setTimeout(() => {
      lapses.delete(id)
      asked.keep(id, false)
    }, askedFor),
  )
  for (const listener of listeners) listener()
}

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
  useEffect(() => {
    listeners.add(redraw)
    return () => void listeners.delete(redraw)
  }, [])
  // Taken up as the choice it stands for, once, by the viewer that shows the file.
  if (asked.get(id)) {
    asked.keep(id, false)
    chosen.keep(id, { path, view: "source" })
  }
  const choose = useCallback(
    (next: FileView) => {
      chosen.keep(id, { path, view: next })
      redraw()
    },
    [id, path],
  )
  return [viewOf(id, path), choose]
}
