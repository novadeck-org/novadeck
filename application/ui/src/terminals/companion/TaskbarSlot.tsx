import { FileStack, FileText, MessagesSquare, Pause, type LucideIcon } from "lucide-react"
import type { ReactNode, Ref } from "react"

import type { ArtifactContent } from "../../model/companion"
import { mailBadgeLabel } from "../../model/messages"
import { ContextMenu, type ContextMenuItem } from "../../ui-toolkit/ContextMenu"
import { HoverCard } from "../../ui-toolkit/HoverCard"
import { iconOf, kindIcons } from "./artifact-icons"
import { isNew, pick, type BarMember, type BarSlot, type StackKind } from "./bar"
import type { MailHandle } from "./mail"
import type { Shown } from "./pane"
import { Peek, type Indicator, type PeekEntry } from "./Peek"
import { fileOf } from "./plan-doc"
import { titleOf } from "./plan-text"
import { ArtifactPreview, MailThumb, PlanThumb } from "./thumbs"

// One icon on a terminal's taskbar: its button, the peek above it with a card for each
// thing behind it, and its menu, which is also the keyboard's way to all the peek offers.

// What the taskbar does for its icons.
export type SlotActions = {
  // What the pane shows while it's open, "" while it's hidden.
  readonly showing: string
  readonly mail: MailHandle
  readonly peerName: (handle: string) => string | undefined
  // The name of the terminal a placed item is from.
  readonly originOf: (member: BarMember) => string
  readonly loadOf: (member: BarMember) => (artifact: Shown) => Promise<ArtifactContent>
  // Opens it in the pane, or hides the pane when it's what the pane shows.
  readonly activate: (id: string) => void
  readonly open: (id: string) => void
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
  const { content } = member
  const look: Look =
    content.kind === "plan"
      ? {
          icon: content.plan.role === "root" ? FileText : FileStack,
          name: fileOf(content.plan),
          label: `${content.plan.role === "root" ? "Plan" : "Subagent plan"}: ${titleOf(content.plan.path, content.plan.text)}`,
        }
      : content.kind === "artifact"
        ? {
            icon: iconOf(content.artifact),
            name: content.artifact.name,
            label: content.artifact.name,
          }
        : { icon: MessagesSquare, name: "Messages", label: "Messages" }
  if (!member.placed) return look
  const origin = actions.originOf(member)
  return { ...look, name: `${look.name} · from ${origin}`, label: `${look.label}, from ${origin}` }
}

const preview = (member: BarMember, actions: SlotActions): ReactNode =>
  member.content.kind === "plan" ? (
    <PlanThumb plan={member.content.plan} />
  ) : member.content.kind === "artifact" ? (
    <ArtifactPreview load={actions.loadOf(member)} artifact={member.content.artifact} />
  ) : (
    <MailThumb mail={actions.mail} peerName={actions.peerName} />
  )

const indicator = (member: BarMember, showing: string): Indicator =>
  isNew(member) ? "new" : member.id === showing ? "open" : "seen"

// A stack's name, as its menu and its count say it.
const stackNames: Record<StackKind, { readonly one: string; readonly many: string }> = {
  plan: { one: "plan", many: "Plans" },
  image: { one: "image", many: "Images" },
  file: { one: "file", many: "Files" },
  page: { one: "page", many: "Pages" },
}

// What can be done with one item, from its menu: in a stack, each named.
const memberMenu = (member: BarMember, actions: SlotActions, named: boolean): ContextMenuItem[] => {
  const name = named ? ` ${lookOf({ ...member, placed: false }, actions).name}` : ""
  const origin = member.placed ? actions.originOf(member) : ""
  const from = named && member.placed ? ` from ${origin}` : ""
  return [
    {
      value: `open-${member.id}`,
      label: `Open${name}${from}`,
      onSelect: () => actions.open(member.id),
    },
    ...(member.placed
      ? [
          {
            value: `send-back-${member.id}`,
            label: named ? `Send${name} back to ${origin}` : `Send back to ${origin}`,
            onSelect: () => actions.sendBack(member),
          },
        ]
      : member.content.kind !== "messages"
        ? [
            {
              value: `window-${member.id}`,
              label: named ? `Undock${name} to its own window` : "Undock to its own window",
              onSelect: () => actions.undock(member),
            },
          ]
        : []),
    {
      value: `close-${member.id}`,
      label: `Close${name}${from}`,
      onSelect: () => actions.close(member),
    },
  ]
}

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
      id: member.id,
      name: look.name,
      icon: <Icon size={13} strokeWidth={1.5} />,
      preview: preview(member, actions),
      state: indicator(member, showing),
      onOpen: () => actions.open(member.id),
      onClose: () => actions.close(member),
      // The messages stay on their terminal's bar.
      ...(member.content.kind === "messages"
        ? {}
        : { onGrab: (event) => actions.grab(event, member, Icon, slot.key) }),
    }
  })
  const single = slot.stack ? undefined : slot.members[0]!
  const look = single
    ? lookOf(single, actions)
    : { icon: slot.stack === "plan" ? FileText : kindIcons[slot.stack!], name: "", label: "" }
  const Icon = look.icon
  const fresh = slot.members.some(isNew)
  const shown = slot.members.find((member) => member.id === showing)
  const names = slot.stack && stackNames[slot.stack]
  const messages = single?.content.kind === "messages"
  const mailLabel = actions.mail.badge
    ? `, ${mailBadgeLabel(actions.mail.badge)}`
    : actions.mail.paused
      ? ", messaging paused"
      : ""
  return (
    <ContextMenu
      label={`${single ? look.name : names!.many} actions`}
      items={
        single
          ? // Close stays last, after moving.
            memberMenu(single, actions, false).toSpliced(-1, 0, ...moving)
          : [...slot.members.flatMap((member) => memberMenu(member, actions, true)), ...moving]
      }
      trigger={
        <span className="plan-tb-slot">
          <HoverCard
            className="plan-tb-peek"
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
                onClick={() => actions.activate((single ?? pick(slot, showing)).id)}
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
