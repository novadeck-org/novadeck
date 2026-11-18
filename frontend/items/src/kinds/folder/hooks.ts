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
// item exists; a folder inside is followed here, for as long as the body is in it.
export const useListing = (
  itemStore: ItemStore,
  target: WorkspaceTarget,
  item: Pick<Item, "id" | "kind">,
  within: string,
): { readonly top: ItemContent | undefined; readonly here: ItemContent | undefined } => {
  const top = useContent(itemStore, target, item)
  const [inside, setInside] = useState<{ within: string; content: ItemContent }>()
  const { projectId, workspaceSessionId } = target
  useEffect(() => {
    if (within === "") return
    return itemStore.listing({ projectId, workspaceSessionId }, item.id, within, (content) =>
      setInside({ within, content }),
    )
  }, [itemStore, projectId, workspaceSessionId, item.id, within])
  // What came for another folder, as the one before this, is not what it holds.
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

// The files being written now: those whose size changed between two listings, for a while after
// the change, each with how many changes it has had meanwhile, which tells one write from the next.
export const useWriting = (
  entries: readonly FolderEntry[] | undefined,
): ReadonlyMap<string, number> => {
  const [writing, setWriting] = useState<ReadonlyMap<string, number>>(new Map())
  const before = useRef<readonly FolderEntry[] | undefined>(undefined)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const was = before.current
    before.current = entries
    if (!was || !entries) return
    const changed = grown(was, entries)
    if (changed.length === 0) return
    setWriting(
      (now) =>
        new Map([...now, ...changed.map((name) => [name, (now.get(name) ?? 0) + 1] as const)]),
    )
    for (const name of changed) {
      clearTimeout(timers.current.get(name))
      timers.current.set(
        name,
        setTimeout(() => {
          timers.current.delete(name)
          setWriting((now) => new Map([...now].filter(([each]) => each !== name)))
        }, writingMs),
      )
    }
  }, [entries])
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer)
    },
    [],
  )
  return writing
}

export const listedFolder = (content: ItemContent | undefined): FolderContent | undefined =>
  content?.state === "ready" && content.content.kind === "folder" ? content.content : undefined
