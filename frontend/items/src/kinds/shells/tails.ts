import type { Item } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { useEffect, useMemo, useSyncExternalStore } from "react"

import type { ItemStore } from "../../store/item-store"
import { lastLineOf } from "./shells"

const noSubscribe = (): (() => void) => () => {}

// What the chat shows under each of its shell lines: the last line of that shell's output, by
// the shell's id, for the shells the terminal's shells item holds output for. The item is
// followed while `active`, as the pane would while it shows it.
export const useShellTails = (
  itemStore: ItemStore | undefined,
  target: WorkspaceTarget,
  item: Pick<Item, "id"> | undefined,
  active: boolean,
): Readonly<Record<string, string>> => {
  const { projectId, workspaceSessionId } = target
  const id = item?.id
  useEffect(
    () =>
      itemStore && id !== undefined && active
        ? itemStore.watch({ projectId, workspaceSessionId }, id)
        : undefined,
    [itemStore, projectId, workspaceSessionId, id, active],
  )
  const content = useSyncExternalStore(itemStore?.store.subscribe ?? noSubscribe, () =>
    itemStore && id !== undefined ? itemStore.store.getSnapshot().content[id] : undefined,
  )
  return useMemo(() => {
    if (content?.state !== "ready" || content.content.kind !== "shells") return {}
    const tails: Record<string, string> = {}
    for (const shell of content.content.shells) {
      const last = lastLineOf(shell.output)
      if (last !== null) tails[shell.id] = last
    }
    return tails
  }, [content])
}
