import { Pause, type LucideIcon } from "lucide-react"
import type { ReactNode, Ref } from "react"

import type { ItemId } from "../../model/companion"
import type { BarKey } from "../../model/companion-bar"
import { mailBadgeLabel } from "../../model/messages"
import type { WorkspaceTarget } from "../../model/types"
import { ContextMenu, type ContextMenuItem } from "../../ui-toolkit/ContextMenu"
import { HoverCard } from "../../ui-toolkit/HoverCard"
import { memberIcon, slotIcon } from "./artifact-icons"
import { isNew, pick, type BarMember, type BarSlot, type StackKind } from "./bar"
import type { MailHandle } from "./mail"
import { Peek, type Indicator, type PeekEntry } from "./Peek"
import type { PlanDoc } from "./plan-doc"
import { titleOf } from "./plan-text"
import type { Panes } from "./state"
import { ArtifactPreview, MailThumb, PlanThumb } from "./thumbs"

// One icon on a terminal's taskbar: its button, the peek above it with a card for each
// thing behind it, and its menu. One thing's menu offers all that can be done with it; a
// stack's only what's done with all of it, and each of its things to open, which is the
// keyboard's way to them as the peek is the pointer's.

// What the taskbar does for its icons.
export type SlotActions = {
  // What the pane shows while it's open, null while it's hidden.
  readonly showing: BarKey | null
  readonly mail: MailHandle
  readonly peerName: (handle: string) => string | undefined
  // The name of the terminal something placed here came from, while it's open.
  readonly originOf: (member: BarMember) => string | undefined
  // The bar's plans as the pane holds them, once loaded.
  readonly plans: Readonly<Record<ItemId, PlanDoc>>
  readonly panes: Panes
  readonly target: WorkspaceTarget
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

// How an item looks on the bar: its icon, its name as the peek and menu say it, how its
// button reads to assistive technology, and its preview.
type Look = { readonly icon: LucideIcon; readonly name: string; readonly label: string }

const lookOf = (member: BarMember, actions: SlotActions): Look => {
  if (member.kind === "messages")
    return { icon: memberIcon(member), name: "Messages", label: "Messages" }
  const { item } = member
  const title = titleOf(item.name, actions.plans[item.id]?.text ?? "")
  const look: Look =
    item.kind === "plan"
      ? {
          icon: memberIcon(member),
          name: title,
          label: `${item.plan?.role === "subagent" ? "Subagent plan" : "Plan"}: ${title}`,
        }
      : { icon: memberIcon(member), name: item.name, label: item.name }
  if (!member.placed) return look
  const origin = actions.originOf(member) ?? "another terminal"
  return { ...look, name: `${look.name} · from ${origin}`, label: `${look.label}, from ${origin}` }
}

const preview = (member: BarMember, actions: SlotActions): ReactNode =>
  member.kind === "messages" ? (
    <MailThumb mail={actions.mail} peerName={actions.peerName} />
  ) : member.item.kind === "plan" ? (
    <PlanThumb panes={actions.panes} item={member.item} />
  ) : (
    <ArtifactPreview panes={actions.panes} target={actions.target} item={member.item} />
  )

const indicator = (member: BarMember, showing: BarKey | null): Indicator =>
  isNew(member) ? "new" : member.key === showing ? "open" : "seen"

// A stack's name, as its menu and its count say it.
const stackNames: Record<StackKind, { readonly one: string; readonly many: string }> = {
  plan: { one: "plan", many: "Plans" },
  image: { one: "image", many: "Images" },
  file: { one: "file", many: "Files" },
  page: { one: "page", many: "Pages" },
}

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

// The messages' count waiting for their agent, or the pause mark.
const MailCount = ({ mail }: { mail: MailHandle }): React.JSX.Element | null =>
  mail.badge ? (
    <b className="plan-tb-count" data-mail={mail.badge.kind} aria-hidden="true">
      {mail.badge.count}
    </b>
  ) : mail.paused ? (
    <b className="plan-tb-count" data-mail="paused" aria-hidden="true">
      <Pause size={8} strokeWidth={2.5} />
    </b>
  ) : null

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
  const { showing } = actions
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
      icon: <Icon size={13} strokeWidth={1.5} />,
      preview: preview(member, actions),
      state: indicator(member, showing),
      onOpen: () => actions.open(member.key),
      onClose: () => actions.close(member),
      // The messages stay on their terminal's bar.
      ...(member.kind === "messages"
        ? {}
        : { onGrab: (event) => actions.grab(event, member, Icon, slot.key) }),
    }
  })
  const single = slot.stack ? undefined : slot.members[0]!
  const look = single ? lookOf(single, actions) : { icon: slotIcon(slot), name: "", label: "" }
  const Icon = look.icon
  const fresh = slot.members.some(isNew)
  const shown = slot.members.find((member) => member.key === showing)
  const names = slot.stack && stackNames[slot.stack]
  const stack = stackMenu(slot.members, names ? names.one : "item", actions)
  const messages = single?.kind === "messages"
  const mailLabel = actions.mail.badge
    ? `, ${mailBadgeLabel(actions.mail.badge)}`
    : actions.mail.paused
      ? ", messaging paused"
      : ""
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
        <span className="plan-tb-slot">
          <HoverCard
            className="plan-tb-peek"
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
                className="plan-tb-item"
                data-state={fresh ? "new" : shown ? "open" : "seen"}
                aria-label={
                  single
                    ? `${look.label}${messages ? mailLabel : fresh ? ", new" : ""}`
                    : `${slot.members.length} ${names!.one}s${fresh ? ", new" : ""}`
                }
                aria-pressed={Boolean(shown)}
                aria-description="Drag to reorder, or use Move left and Move right in its menu."
                onClick={() => actions.activate((single ?? pick(slot, showing)).key)}
              >
                <Icon size={20} strokeWidth={1.5} />
                {messages ? (
                  <MailCount mail={actions.mail} />
                ) : (
                  !single && (
                    <b className="plan-tb-count" aria-hidden="true">
                      {slot.members.length}
                    </b>
                  )
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
