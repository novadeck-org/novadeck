import type { Item } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"

import type { ItemStore } from "../../store/item-store"
import { lastLineOf } from "./shells"

// What the chat shows under each of its shell lines: the last line of each shell's output, by
// the shell's id, for the shells the terminal's shells item holds output for. The chat
// subscribes to it where it draws them, so only the lines re-render as the output moves, and
// only when a last line changed.
export type ShellTails = {
  // Follows the item while the chat shows lines that need it, as the pane would while it shows
  // it; call what it returns to stop.
  readonly watch: () => () => void
  readonly subscribe: (on: () => void) => () => void
  // The same record for as long as no last line changed.
  readonly snapshot: () => Readonly<Record<string, string>>
}

const noTails: Readonly<Record<string, string>> = {}

const sameTails = (
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

export const shellTailsOf = (
  itemStore: ItemStore,
  target: WorkspaceTarget,
  item: Pick<Item, "id">,
): ShellTails => {
  const { projectId, workspaceSessionId } = target
  let seen: unknown
  let tails = noTails
  return {
    watch: () => itemStore.watch({ projectId, workspaceSessionId }, item.id),
    subscribe: itemStore.store.subscribe,
    snapshot: () => {
      const content = itemStore.store.getSnapshot().content[item.id]
      if (content === seen) return tails
      seen = content
      const next: Record<string, string> = {}
      if (content?.state === "ready" && content.content.kind === "shells")
        for (const shell of content.content.shells) {
          const last = lastLineOf(shell.output)
          if (last !== null) next[shell.id] = last
        }
      if (!sameTails(tails, next)) tails = next
      return tails
    },
  }
}
