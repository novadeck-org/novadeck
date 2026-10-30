import type { Item, ItemId } from "@novadeck/core/items"
import type { Workspace } from "@novadeck/core/types"

// What the workspace says about an item, apart from what it holds: which file it points at
// and where it is.

// Which file an item shows, for a file or an image, and what kind it is otherwise. The same
// item shown another file is something else to read, as the project window's is when the
// person opens another; any other change, as new lines or a new route, replaces content in place.
export const pointedAt = (item: Pick<Item, "kind" | "path">): string =>
  JSON.stringify([item.kind, item.kind === "file" || item.kind === "image" ? item.path : null])

export const itemIn = (workspace: Workspace, id: ItemId): Item | undefined => {
  for (const project of workspace.projects)
    for (const each of project.history) {
      const item = each.state.items.find((candidate) => candidate.id === id)
      if (item) return item
    }
  return undefined
}

export const pointedIn = (workspace: Workspace, id: ItemId): string | undefined => {
  const item = itemIn(workspace, id)
  return item && pointedAt(item)
}

// Each session's items, which change far less often than the workspace.
export const itemsOf = (workspace: Workspace) =>
  workspace.projects.flatMap((project) => project.history.map((each) => each.state.items))

// A record without the items that are gone.
export const keep = <Value>(
  present: ReadonlyMap<ItemId, unknown>,
  record: Readonly<Record<ItemId, Value>>,
) => {
  const kept = Object.entries(record).filter(([id]) => present.has(id as ItemId))
  return kept.length === Object.keys(record).length
    ? record
    : (Object.fromEntries(kept) as Record<ItemId, Value>)
}
