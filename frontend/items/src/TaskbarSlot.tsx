import type { ItemId } from "@novadeck/core/items"
import type { BarKey } from "@novadeck/core/items/companion-bar"
import { ContextMenu, type ContextMenuItem } from "@novadeck/toolkit/ContextMenu"
import { HoverCard } from "@novadeck/toolkit/HoverCard"
import type { LucideIcon } from "lucide-react"
import type { ReactNode, Ref } from "react"

import { isNew, pick, type BarMember, type BarSlot } from "./bar"
import { Peek, type Indicator, type PeekEntry } from "./Peek"
import { stackIcon, stackNames, type Look } from "./registry"

// One icon on a terminal's taskbar: its button, the peek above it with a card for each
// thing behind it, and its menu. One thing's menu offers all that can be done with it; a
// stack's only what's done with all of it, and each of its things to open, which is the
// keyboard's way to them as the peek is the pointer's.

// How the home draws what's on its bar: an item by its kind's registration, and what's the
// home's own, as a terminal's messages, as the home says.
export type BarDrawing = {
  // Its icon, its name as the peek and menu say it, and how its button reads to assistive
  // technology.
  readonly look: (member: BarMember) => Look
  // Its peek's miniature.
  readonly preview: (member: BarMember) => ReactNode
  // What the home adds to its icon, as a terminal its messages' count, and what its
  // button's label says of it, in place of the count and the "new" a slot otherwise has,
  // even while both are empty. None, for an item.
  readonly badge: (
    member: BarMember,
  ) => { readonly mark: ReactNode; readonly label: string } | undefined
}

// What the taskbar does for its icons.
export type SlotActions = {
  // What the pane shows while it's open, null while it's hidden.
  readonly showing: BarKey | null
  // What's open in the pane, the top last, shown or waiting while it's hidden.
  readonly stacked: readonly BarKey[]
  readonly draw: BarDrawing
  // The name of the terminal something placed here came from, while it's open.
  readonly originOf: (member: BarMember) => string | undefined
  // Opens it in the pane, or hides the pane when it's what the pane shows.
  readonly activate: (key: BarKey) => void
  readonly open: (key: BarKey) => void
  // The person looked at these in a peek without opening them.
  readonly seen: (itemIds: readonly ItemId[]) => void
  readonly close: (member: BarMember) => void
  readonly sendBack: (member: BarMember) => void
  readonly undock: (member: BarMember) => void
  readonly move: (from: number, to: number) => void
  // Pressing on a peek's card may pull it out as an icon of its own.
  readonly grab: (
    event: React.PointerEvent<HTMLElement>,
    member: BarMember,
    icon: LucideIcon,
    slot: string,
  ) => void
}

// How something looks on the bar, as the home draws it, saying where it came from when
// it was placed here from another terminal.
export const lookOf = (member: BarMember, actions: SlotActions): Look => {
  const look = actions.draw.look(member)
  if (member.kind === "messages" || !member.placed) return look
  const origin = actions.originOf(member) ?? "another terminal"
  return { ...look, name: `${look.name} · from ${origin}`, label: `${look.label}, from ${origin}` }
}

const indicator = (
  member: BarMember,
  showing: BarKey | null,
  stacked: readonly BarKey[],
): Indicator =>
  isNew(member)
    ? "new"
    : member.key === showing
      ? "open"
      : stacked.includes(member.key)
        ? "behind"
        : "seen"

// What can be done with one item, from its menu.
const memberMenu = (member: BarMember, actions: SlotActions): ContextMenuItem[] => {
  const placed = member.kind === "item" && member.placed
  const origin = placed ? actions.originOf(member) : undefined
  return [
    { value: `open-${member.key}`, label: "Open", onSelect: () => actions.open(member.key) },
    // Something placed here goes back to its terminal while that's open.
    ...(placed && origin
      ? [
          {
            value: `send-back-${member.key}`,
            label: `Send back to ${origin}`,
            onSelect: () => actions.sendBack(member),
          },
        ]
      : member.kind === "item" && !placed
        ? [
            {
              value: `window-${member.key}`,
              label: "Undock to its own window",
              onSelect: () => actions.undock(member),
            },
          ]
        : []),
    { value: `close-${member.key}`, label: "Close", onSelect: () => actions.close(member) },
  ]
}

// What's done with a whole stack, from its menu, beside moving it: each of its things to
// open, by name, and closing all of them.
const stackMenu = (
  members: readonly BarMember[],
  one: string,
  actions: SlotActions,
): { readonly open: ContextMenuItem; readonly close: ContextMenuItem } => ({
  open: {
    value: "open",
    label: "Open",
    items: members.map((member) => ({
      value: `open-${member.key}`,
      label: lookOf(member, actions).name,
      onSelect: () => actions.open(member.key),
    })),
  },
  close: {
    value: "close-all",
    label: `Close ${members.length} ${one}s`,
    onSelect: () => {
      for (const member of members) actions.close(member)
    },
  },
})

export const TaskbarSlot = ({
  slot,
  index,
  count,
  actions,
  buttonRef,
}: {
  slot: BarSlot
  index: number
  // How many icons the bar has.
  count: number
  actions: SlotActions
  // The first icon's, which focus comes back to when the pane hides.
  buttonRef: Ref<HTMLButtonElement> | undefined
}): React.JSX.Element => {
  const { showing, stacked } = actions
  const moving: ContextMenuItem[] = [
    ...(index > 0
      ? [{ value: "move-left", label: "Move left", onSelect: () => actions.move(index, index - 1) }]
      : []),
    ...(index < count - 1
      ? [
          {
            value: "move-right",
            label: "Move right",
            onSelect: () => actions.move(index, index + 1),
          },
        ]
      : []),
  ]
  const entries = slot.members.map((member): PeekEntry => {
    const look = lookOf(member, actions)
    const Icon = look.icon
    return {
      id: member.key,
      name: look.name,
      icon: <Icon size={14} strokeWidth={1.5} />,
      preview: actions.draw.preview(member),
      state: indicator(member, showing, stacked),
      onOpen: () => actions.open(member.key),
      onClose: () => actions.close(member),
      // The messages stay on their terminal's bar.
      ...(member.kind === "messages"
        ? {}
        : { onGrab: (event) => actions.grab(event, member, Icon, slot.key) }),
    }
  })
  const single = slot.stack ? undefined : slot.members[0]!
  const look = single
    ? lookOf(single, actions)
    : { icon: stackIcon(slot.stack!), name: "", label: "" }
  const Icon = look.icon
  const fresh = slot.members.some(isNew)
  const shown = slot.members.find((member) => member.key === showing)
  const behind = !shown && slot.members.some((member) => stacked.includes(member.key))
  const openLabel = behind ? ", in the pane" : ""
  const names = slot.stack && stackNames(slot.stack)
  const stack = stackMenu(slot.members, names ? names.one : "item", actions)
  const badge = single && actions.draw.badge(single)
  return (
    <ContextMenu
      label={`${single ? look.name : names!.many} actions`}
      items={
        // Close stays last, after moving.
        single
          ? memberMenu(single, actions).toSpliced(-1, 0, ...moving)
          : [stack.open, ...moving, stack.close]
      }
      trigger={
        <span className="taskbar-slot">
          <HoverCard
            className="taskbar-peek"
            // What was new in a peek the person looked at is new no more once it closes.
            onOpenChange={(open) => {
              const newKeys = slot.members.flatMap((member) =>
                member.kind === "item" && isNew(member) ? [member.key] : [],
              )
              if (!open && newKeys.length) actions.seen(newKeys)
            }}
            trigger={
              <button
                ref={buttonRef}
                className="taskbar-item"
                data-state={fresh ? "new" : shown ? "open" : behind ? "behind" : "seen"}
                aria-label={
                  single
                    ? `${look.label}${badge ? badge.label : fresh ? ", new" : ""}${openLabel}`
                    : `${slot.members.length} ${names!.one}s${fresh ? ", new" : ""}${openLabel}`
                }
                aria-pressed={Boolean(shown)}
                aria-description="Drag to reorder, or use Move left and Move right in its menu."
                onClick={() => actions.activate((single ?? pick(slot, stacked)).key)}
              >
                <Icon size={20} strokeWidth={1.5} />
                {badge
                  ? badge.mark
                  : !single && (
                      <b className="taskbar-count" aria-hidden="true">
                        {slot.members.length}
                      </b>
                    )}
              </button>
            }
          >
            <Peek entries={entries} />
          </HoverCard>
        </span>
      }
    />
  )
}
