import { isOnBar, type CompanionItem, type ItemId, type ItemKind } from "../../model/companion"
import { messagesKey, type Bar, type BarKey } from "../../model/companion-bar"
import type { WindowPlace } from "../../model/layout/window-place"
import type { BarDrag } from "../drag-session"

// A terminal's taskbar, drawn from the items it holds, less what the person hid, and its
// messages. Items of a kind stack under one icon once there are several, as a taskbar
// groups an app's windows; the messages never stack. Everything keeps the order it came
// in, or the person dragged it into.

// One thing on a terminal's taskbar. `placed` when it was shown from another terminal.
export type BarMember =
  | {
      readonly kind: "item"
      readonly key: ItemId
      readonly item: CompanionItem
      readonly placed: boolean
      // Shown anew or again since the person last looked.
      readonly fresh: boolean
    }
  | { readonly kind: "messages"; readonly key: typeof messagesKey }

export type ItemMember = Extract<BarMember, { readonly kind: "item" }>

export type StackKind = ItemKind

// An icon on the bar: one member, or a stack of a kind. `key` stays the same as it moves.
export type BarSlot = {
  readonly key: string
  readonly stack: StackKind | null
  readonly members: readonly BarMember[]
}

const stackOf = (member: BarMember): StackKind | null =>
  member.kind === "item" ? member.item.kind : null

// Whether it waits for the person to look.
export const isNew = (member: BarMember): boolean => member.kind === "item" && member.fresh

// Something that may hold secrets, which opens only when picked.
export const isHeld = (member: BarMember): boolean => member.kind === "item" && member.item.held

// What terminal `terminalId`'s bar holds: the items on it but those the person hid, and
// its messages while it has them.
export const barMembers = ({
  terminalId,
  bar,
  items,
  fresh,
  messages,
}: {
  readonly terminalId: string
  readonly bar: Bar
  readonly items: readonly CompanionItem[]
  readonly fresh: Readonly<Record<ItemId, true>>
  readonly messages: boolean
}): readonly BarMember[] => [
  ...items
    .filter((item) => isOnBar(item, terminalId) && !bar.hidden.includes(item.id))
    .map((item): BarMember => ({
      kind: "item",
      key: item.id,
      item,
      placed: item.from.terminalId !== terminalId,
      fresh: Boolean(fresh[item.id]),
    })),
  ...(messages && !bar.hidden.includes(messagesKey)
    ? [{ kind: "messages", key: messagesKey } as const]
    : []),
]

// The bar's icons in order: each member where it came, a stack where its first member
// came, and anything the order doesn't know yet after, as given.
export const composeBar = (bar: Bar, members: readonly BarMember[]): readonly BarSlot[] => {
  const rank = (member: BarMember): number => {
    const place = bar.order.indexOf(member.key)
    return place < 0 ? bar.order.length + members.indexOf(member) : place
  }
  const sorted = members.toSorted((a, b) => rank(a) - rank(b))
  const stacks = new Map<StackKind, BarMember[]>()
  for (const member of sorted) {
    const kind = stackOf(member)
    if (kind) stacks.set(kind, [...(stacks.get(kind) ?? []), member])
  }
  return sorted.flatMap((member): BarSlot[] => {
    const kind = stackOf(member)
    const stack = kind ? stacks.get(kind)! : [member]
    if (stack.length < 2) return [{ key: member.key, stack: null, members: [member] }]
    return stack[0] === member ? [{ key: `stack:${kind}`, stack: kind, members: stack }] : []
  })
}

// Each icon by the keys it stands for, as a move along the bar takes them.
export const slotKeys = (slots: readonly BarSlot[]): readonly (readonly BarKey[])[] =>
  slots.map((slot) => slot.members.map((member) => member.key))

// What the pane shows: its tab, while that's on the bar, or else the bar's first plan, or
// else the first thing that may show unpicked, never a held one. Nothing, when null.
export const shownTab = (bar: Bar, members: readonly BarMember[]): BarKey | null => {
  const tab = members.find((member) => member.key === bar.tab)
  if (tab) return tab.key
  const plan = members.find((member) => member.kind === "item" && member.item.kind === "plan")
  return (plan ?? members.find((member) => member.kind === "item" && !isHeld(member)))?.key ?? null
}

// Which of a stack a click opens. Of plans: the first rewritten since it was read, else
// the one open, else the first, the root plan where it's among them. Of anything else:
// what's new, else what's open, else the latest, a held one only when the stack holds
// nothing else, as the click then picks it.
export const pick = (slot: BarSlot, showing: BarKey | null): BarMember => {
  const open = slot.members.find((member) => member.key === showing)
  if (slot.stack === "plan") {
    const root = slot.members.find(
      (member) => member.kind === "item" && member.item.plan?.role === "root",
    )
    return slot.members.find(isNew) ?? open ?? root ?? slot.members[0]!
  }
  return (
    slot.members.findLast((member) => isNew(member) && !isHeld(member)) ??
    open ??
    slot.members.findLast((member) => !isHeld(member)) ??
    slot.members.at(-1)!
  )
}

// Whether a drop on a view's free space opens what's dragged in a window of its own: one
// thing this terminal's agent showed. A stack, the messages and something placed here
// from another terminal don't undock.
export const undocks = (members: readonly BarMember[]): boolean => {
  const [only] = members
  return members.length === 1 && only?.kind === "item" && !only.placed
}

export type DropOutcome =
  | { readonly kind: "place"; readonly itemIds: readonly ItemId[]; readonly terminalId: string }
  | { readonly kind: "undock"; readonly itemId: ItemId; readonly place: WindowPlace }

// Where what was dragged off terminal `terminal`'s bar lands: on another terminal's bar,
// each of a stack's items; on a view's free space, in a window of its own. Nothing, as
// when it's dropped back where it was.
export const dropOutcome = (
  members: readonly BarMember[],
  ended: BarDrag,
  terminal: string,
): DropOutcome | null => {
  const items = members.filter((member): member is ItemMember => member.kind === "item")
  if (ended.onBar && ended.over && ended.over !== terminal)
    return items.length
      ? { kind: "place", itemIds: items.map((member) => member.key), terminalId: ended.over }
      : null
  const [only] = items
  return ended.place && only && undocks(members)
    ? { kind: "undock", itemId: only.key, place: ended.place }
    : null
}
