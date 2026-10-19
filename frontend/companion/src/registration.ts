import type { ItemId, ItemKind } from "@novadeck/core/companion"
import type { WorkspaceTarget } from "@novadeck/core/types"
import type { LucideIcon } from "lucide-react"
import type { ComponentType, ReactNode } from "react"

import type { BarMember, ItemMember, MessagesMember } from "./bar"
import type { MailHandle } from "./panes/messages/mail"
import type { PlanDoc } from "./panes/plan/plan-doc"
import type { Panes } from "./state"

// What a kind of thing on the bar is to the pane: everything the UI needs to draw it. The
// kinds are core's item kinds, which stay closed (the runner produces them and the UI
// validates them), and the messages, which are a pane and not an item.
export type PaneKind = ItemKind | "messages"

// What a registration may read to say how a member looks.
export type LookContext = {
  // The bar's plans as the pane holds them, once loaded.
  readonly plans: Readonly<Record<ItemId, PlanDoc>>
}

type Context = { readonly panes: Panes; readonly target: WorkspaceTarget }
type MailContext = {
  readonly mail: MailHandle
  readonly peerName: (handle: string) => string | undefined
}

// What a peek's miniature is given. The messages' also get their terminal's mail.
export type ThumbProps<M extends ItemMember | MessagesMember> = M extends MessagesMember
  ? Context & MailContext & { readonly member: M }
  : Context & { readonly member: M }

// What the pane's body is given, with what the place showing it offers at the end of its
// header. The chrome around it is the pane's: its header, its actions, the line saying
// whose it is and the states of what can't show.
export type ViewProps<M extends ItemMember | MessagesMember> = ThumbProps<M> & {
  readonly actions: ReactNode
}

// A registration is everything the UI needs to draw one kind of thing on the bar. It lives
// in a folder of `src/panes/`, and the registry holds one line for it.
export type PaneRegistration<
  M extends ItemMember | MessagesMember,
  K extends PaneKind = PaneKind,
> = {
  readonly kind: K
  // Its stack's name ("image", "Images").
  readonly names: { readonly one: string; readonly many: string }
  // One member, on the taskbar and the terminal's tab.
  readonly icon: (member: M) => LucideIcon
  // A stack of the kind, which takes the kind's icon whatever its members are.
  readonly stackIcon: LucideIcon
  // The member's name as the peek and menu say it, and how its button reads to assistive
  // technology.
  readonly look: (
    member: M,
    context: LookContext,
  ) => { readonly name: string; readonly label: string }
  // Its peek miniature.
  readonly Thumb: ComponentType<ThumbProps<M>>
  // The pane's body for it.
  readonly View: ComponentType<ViewProps<M>>
  // Set when the kind's body reads as a document in a window of its own: the window frames
  // it, as the pane does, under this label.
  readonly windowLabel?: string
}

// Every kind has its registration, so a kind core adds without one fails to compile here.
export type Registry = {
  readonly [K in PaneKind]: PaneRegistration<K extends "messages" ? MessagesMember : ItemMember, K>
}

// A registration as whoever draws a bar's member by its kind sees it: it gives every
// registration all it may read, and each takes what its kind needs.
export type Drawing = Omit<PaneRegistration<BarMember>, "Thumb" | "View"> & {
  readonly Thumb: ComponentType<Context & MailContext & { readonly member: BarMember }>
  readonly View: ComponentType<
    Context & MailContext & { readonly member: BarMember; readonly actions: ReactNode }
  >
}
