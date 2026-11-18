import type { FolderContent, FolderEntry, Item, ItemContent } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"

import type { ItemStore } from "../../store/item-store"
import { useContent } from "../../store/use-item-store"
import { arrive, defaultFolderView, grown, noArrivals, writingMs, type FolderView } from "./model"

// How a folder item is looked at, as its item store keeps it.
export const useFolderView = (itemStore: ItemStore, itemId: Item["id"]): FolderView =>
  useSyncExternalStore(
    itemStore.store.subscribe,
    () => itemStore.store.getSnapshot().folders[itemId] ?? defaultFolderView,
  )

// What the folder the view is in holds. The item's own content is its top's, followed while the
// item exists; a folder inside is followed here, for as long as the body is in it, and what the
// item store holds of it is cleared as the view moves, so another folder's listing never stands
// for it.
export const useListing = (
  itemStore: ItemStore,
  target: WorkspaceTarget,
  item: Pick<Item, "id" | "kind">,
  within: string,
): { readonly top: ItemContent | undefined; readonly here: ItemContent | undefined } => {
  const top = useContent(itemStore, target, item)
  const inside = useSyncExternalStore(
    itemStore.store.subscribe,
    () => itemStore.store.getSnapshot().listings[item.id],
  )
  const { projectId, workspaceSessionId } = target
  useEffect(() => {
    if (within === "") return
    return itemStore.listing({ projectId, workspaceSessionId }, item.id, within)
  }, [itemStore, projectId, workspaceSessionId, item.id, within])
  return {
    top,
    here: within === "" ? top : inside?.within === within ? inside.content : undefined,
  }
}

// The listing as it is drawn: new files wait while `holding` (the pointer is in the grid), and
// `release` lets them in. Each folder starts afresh: what it holds is drawn whole when it is
// entered, whether or not the pointer is in the grid.
export const useArrivals = (
  entries: readonly FolderEntry[] | undefined,
  holding: boolean,
  within: string,
): {
  readonly visible: readonly FolderEntry[]
  readonly waiting: number
  readonly fresh: ReadonlySet<string>
  readonly release: () => void
} => {
  const [kept, setKept] = useState({ within, state: noArrivals })
  const names = entries?.map((entry) => entry.name)
  const state = kept.within === within ? kept.state : noArrivals
  // Derived while rendering, as a state that follows what it is given.
  const next = names ? arrive(state, names, holding) : state
  if (next !== kept.state || kept.within !== within) setKept({ within, state: next })
  const listed = names && JSON.stringify(names)
  const release = useCallback(() => {
    setKept((was) => ({
      ...was,
      state: listed === undefined ? was.state : arrive(was.state, JSON.parse(listed), false),
    }))
  }, [listed])
  return {
    visible: entries?.filter((entry) => !next.held.has(entry.name)) ?? [],
    waiting: next.held.size,
    fresh: next.fresh,
    release,
  }
}

// The files being written now: those whose size changed between two listings of the folder
// `within` names, for a while after the change, each with how many changes it has had meanwhile,
// which tells one write from the next. A folder is its own: the files of another, though they
// have the names of these, are not written to by the view having moved.
export const useWriting = (
  entries: readonly FolderEntry[] | undefined,
  within: string,
): ReadonlyMap<string, number> => {
  const [kept, setKept] = useState<{ within: string; writing: ReadonlyMap<string, number> }>({
    within,
    writing: new Map(),
  })
  const before = useRef<{ within: string; entries: readonly FolderEntry[] | undefined }>({
    within,
    entries: undefined,
  })
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const was = before.current
    before.current = { within, entries }
    if (was.within !== within || !was.entries || !entries) return
    const changed = grown(was.entries, entries)
    if (changed.length === 0) return
    setKept((now) => {
      const base = now.within === within ? now.writing : new Map<string, number>()
      return {
        within,
        writing: new Map([
          ...base,
          ...changed.map((name) => [name, (base.get(name) ?? 0) + 1] as const),
        ]),
      }
    })
    for (const name of changed) {
      clearTimeout(timers.current.get(name))
      timers.current.set(
        name,
        setTimeout(() => {
          timers.current.delete(name)
          setKept((now) =>
            now.within === within
              ? { within, writing: new Map([...now.writing].filter(([each]) => each !== name)) }
              : now,
          )
        }, writingMs),
      )
    }
  }, [entries, within])
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer)
    },
    [],
  )
  return kept.within === within ? kept.writing : none
}

const none: ReadonlyMap<string, number> = new Map()

export const listedFolder = (content: ItemContent | undefined): FolderContent | undefined =>
  content?.state === "ready" && content.content.kind === "folder" ? content.content : undefined
