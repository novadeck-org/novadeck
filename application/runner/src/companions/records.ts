import type { AgentName, CompanionItem } from "@novadeck/protocol"

/**
 * An item as the runner keeps it: a pointer, never a copy, held by one terminal's bar or
 * one window. `pointerKey` tells two items apart on one bar: a file's resolved path, a
 * page's address, or a plan's slot (`plan:<agent session>:<actor>`). A plan points at its
 * file, or for one presented as text at the transcript or rollout that records it.
 */
export type ItemRecord = {
  readonly id: string
  readonly sessionId: string
  readonly terminalId: string | null
  readonly windowId: string | null
  readonly pointerKey: string
  readonly kind: CompanionItem["kind"]
  readonly path: string | null
  readonly url: string | null
  readonly lines: { readonly from: number; readonly to: number } | null
  readonly plan: {
    readonly agent: AgentName
    readonly session: string
    /** The harness's own id of the subagent whose plan it is; null for the root agent. */
    readonly actor: string | null
    readonly format: "file" | "text"
  } | null
  readonly name: string
  readonly detail: string
  readonly held: boolean
  readonly by: CompanionItem["by"]
  readonly from: { readonly terminalId: string; readonly handle: string }
  readonly version: number
  readonly asked: boolean
  readonly shownAt: number
  /** When the plan it points at was last observed, by its harness's clock; null otherwise. */
  readonly observedAt: number | null
}

/** An undocked window: its item, by a join, and the title the person gave it, if any. */
export type WindowRecord = {
  readonly id: string
  readonly sessionId: string
  readonly itemId: string
  readonly itemName: string
  readonly personTitle: string | null
}

/** What placing an item changed besides the item itself. */
export type Placed = {
  readonly item: ItemRecord
  /** The window it left, now gone. */
  readonly left: WindowRecord | undefined
  /** An item the target bar held under the same pointer, which it replaced. */
  readonly replaced: ItemRecord | undefined
}

/** Where the runner keeps items and windows: its metadata store. */
export type ItemRecords = {
  item(itemId: string): ItemRecord | undefined
  /** Every item, of one session or all, oldest shown first. */
  items(sessionId?: string): readonly ItemRecord[]
  /** The items one terminal's bar holds, oldest shown first. */
  barItems(terminalId: string): readonly ItemRecord[]
  /** Items under one pointer, wherever they are held. */
  itemsAt(sessionId: string, pointerKey: string): readonly ItemRecord[]
  window(windowId: string): WindowRecord | undefined
  windows(sessionId?: string): readonly WindowRecord[]
  /** Adds an item, or changes the one with its id. */
  saveItem(item: ItemRecord): void
  /**
   * Moves an item onto a terminal's bar, at once deleting the window it leaves and an
   * item the bar holds under the same pointer.
   */
  dockItem(itemId: string, terminalId: string): Placed
  /** Moves an item into a new window, at once deleting the window it leaves. */
  undockItem(itemId: string, window: { readonly id: string; readonly createdAt: number }): Placed
  /** Deletes an item and the window holding it; what was deleted, if anything. */
  removeItem(itemId: string): { item: ItemRecord; window: WindowRecord | undefined } | undefined
  /** Gives a window the person's title, or with null takes it away; false when none has its id. */
  renameWindow(windowId: string, title: string | null): boolean
}
