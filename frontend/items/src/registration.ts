import type { Item, ItemId, ItemKind } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import type { LucideIcon } from "lucide-react"
import type { ComponentType, ReactNode } from "react"

import type { PlanDoc } from "./kinds/plan/plan-doc"
import type { ItemStore } from "./state"

// What a kind of item is to the places that show it: everything they need to draw it. The
// kinds are core's item kinds, which stay closed (the runner produces them and the UI
// validates them). What a home shows of its own beside them, as a terminal its messages,
// is that home's.

// What a registration may read to say how an item looks.
export type LookContext = {
  // The plans as the item store holds them, once loaded.
  readonly plans: Readonly<Record<ItemId, PlanDoc>>
}

// What a kind's views are given: the item, and where its content comes from.
export type ItemProps = {
  readonly item: Item
  readonly itemStore: ItemStore
  readonly target: WorkspaceTarget
}

// What the body is given, with what the place showing it offers at the end of its header.
// The chrome around it is that place's: in a terminal's pane, its header, its actions, the
// line saying whose it is and the states of what can't show.
export type ViewProps = ItemProps & { readonly actions: ReactNode }

// A registration is everything a place needs to draw one kind of item. It lives in a
// folder of `src/kinds/`, and the registry holds one line for it.
export type ItemRegistration<K extends ItemKind = ItemKind> = {
  readonly kind: K
  // Its stack's name ("image", "Images").
  readonly names: { readonly one: string; readonly many: string }
  // One item, on a bar and on a terminal's tab.
  readonly icon: (item: Item) => LucideIcon
  // A stack of the kind, which takes the kind's icon whatever its items are.
  readonly stackIcon: LucideIcon
  // The item's name as a peek and a menu say it, and how its button reads to assistive
  // technology.
  readonly look: (
    item: Item,
    context: LookContext,
  ) => { readonly name: string; readonly label: string }
  // Its peek miniature.
  readonly Thumb: ComponentType<ItemProps>
  // The body that shows it.
  readonly View: ComponentType<ViewProps>
  // Set when the kind's body reads as a document in a window of its own: the window frames
  // it, as the pane does, under this label.
  readonly windowLabel?: string
}

// Every kind has its registration, so a kind core adds without one fails to compile here.
export type Registry = { readonly [K in ItemKind]: ItemRegistration<K> }
