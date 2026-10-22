import { mailBadgeLabel } from "@novadeck/core/messages"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { MessagesSquare, Pause, type LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

import type { BarMember, BarSlot } from "../../bar"
import type { LookContext } from "../../registration"
import { itemLook, registrationOf, stackIcon, type Look } from "../../registry"
import type { ItemStore } from "../../state"
import type { BarDrawing } from "../../TaskbarSlot"
import type { MailHandle } from "./messages/mail"
import { MailThumb } from "./messages/MailThumb"
import { MessagesView } from "./messages/MessagesView"

// How a terminal's home draws what's on its bar: an item by its kind's registration, and
// the terminal's messages, which are its own and not an item, never stacking.

const messagesLook: Look = { icon: MessagesSquare, name: "Messages", label: "Messages" }

// What's on the bar as the peek, the menu and the pane name it.
export const memberLook = (member: BarMember, context: LookContext): Look =>
  member.kind === "messages" ? messagesLook : itemLook(member.item, context)

// What's on the bar as its icon shows it, on the taskbar and the terminal's tab.
const memberIcon = (member: BarMember): LucideIcon =>
  member.kind === "messages" ? messagesLook.icon : registrationOf(member.item).icon(member.item)

// An icon on the bar: its one member's, or its stack's kind, whatever the members are.
export const slotIcon = (slot: BarSlot): LucideIcon =>
  slot.stack ? stackIcon(slot.stack) : memberIcon(slot.members[0]!)

// What the messages' views read beside the item store.
type MailProps = {
  readonly mail: MailHandle
  readonly peerName: (handle: string) => string | undefined
}

// Where what's drawn comes from: the item store for items, the mail for the messages.
type Sources = MailProps & { readonly itemStore: ItemStore; readonly target: WorkspaceTarget }

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

// The terminal's taskbar's drawing of its bar.
export const terminalDrawing = ({
  plans,
  ...sources
}: Sources & { readonly plans: LookContext["plans"] }): BarDrawing => ({
  look: (member) => memberLook(member, { plans }),
  preview: (member) => {
    if (member.kind === "messages")
      return <MailThumb mail={sources.mail} peerName={sources.peerName} />
    const { Thumb } = registrationOf(member.item)
    return <Thumb item={member.item} itemStore={sources.itemStore} target={sources.target} />
  },
  badge: (member) =>
    member.kind !== "messages"
      ? undefined
      : {
          mark: <MailCount mail={sources.mail} />,
          label: sources.mail.badge
            ? `, ${mailBadgeLabel(sources.mail.badge)}`
            : sources.mail.paused
              ? ", messaging paused"
              : "",
        },
})

// What the pane shows of one thing on the bar: the messages, or an item by its kind.
export const MemberView = ({
  member,
  itemStore,
  target,
  mail,
  peerName,
  actions,
}: Sources & { member: BarMember; actions: ReactNode }): React.JSX.Element => {
  if (member.kind === "messages")
    return <MessagesView mail={mail} peerName={peerName} actions={actions} />
  const { View } = registrationOf(member.item)
  return <View item={member.item} itemStore={itemStore} target={target} actions={actions} />
}
