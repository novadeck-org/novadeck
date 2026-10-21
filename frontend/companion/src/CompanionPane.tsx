import type { WorkspaceTarget } from "@novadeck/core/types"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { createLucideIcon, Minus, X } from "lucide-react"
import type { ReactNode } from "react"

import type { BarMember } from "./bar"
import type { MailHandle } from "./panes/messages/mail"
import { registrationOf } from "./registry"
import type { Panes, PlanPresentation } from "./state"

// Windows' restore glyph, drawn as lucide draws: a window lifting off the one it was
// maximized in, as an item docked in the pane lifts into a window of its own.
const Restore = createLucideIcon("restore", [
  ["rect", { x: "3", y: "8", width: "13", height: "13", rx: "2", key: "front" }],
  ["path", { d: "M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3", key: "back" }],
])

// What the pane does with what it shows, at the end of its header, as a window's title
// bar does on Windows: minimizes the pane back to the taskbar, as Escape does; undocks
// what it shows into a window of its own, where it can; and closes it, off the taskbar,
// as the taskbar's menu does.
const PaneActions = ({
  name,
  onUndock,
  onHide,
  onClose,
}: {
  // What the pane shows, as closing it names it.
  name: string
  onUndock: (() => void) | undefined
  onHide: () => void
  onClose: () => void
}): React.JSX.Element => (
  <span className="artifact-actions">
    <Tooltip content="Minimize to the taskbar · Esc">
      <button
        type="button"
        className="icon-button"
        aria-label="Minimize to the taskbar"
        onClick={onHide}
      >
        <Minus size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
    {onUndock && (
      <Tooltip content="Undock to its own window">
        <button
          type="button"
          className="icon-button"
          aria-label="Undock to its own window"
          onClick={onUndock}
        >
          <Restore size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </Tooltip>
    )}
    <Tooltip content="Close">
      <button type="button" className="icon-button" aria-label={`Close ${name}`} onClick={onClose}>
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
  </span>
)

// What the pane shows of one thing on the bar.
const MemberTab = ({
  member,
  panes,
  target,
  mail,
  peerName,
  actions,
}: {
  member: BarMember
  panes: Panes
  target: WorkspaceTarget
  mail: MailHandle
  peerName: (handle: string) => string | undefined
  actions: ReactNode
}): React.JSX.Element => {
  const { View } = registrationOf(member)
  return (
    <View
      member={member}
      panes={panes}
      target={target}
      mail={mail}
      peerName={peerName}
      actions={actions}
    />
  )
}

// A terminal's companion pane, wherever it is presented: what it shows of the terminal's
// taskbar, `member`: a plan, edited where it's read, something an agent showed, its
// messages, or another terminal's item placed here, under a line saying whose it is.
export const CompanionPane = ({
  member,
  panes,
  target,
  agent,
  mail,
  peerName,
  presentation,
  originOf,
  onUndock,
  onHide,
  onClose,
}: {
  member: BarMember | undefined
  panes: Panes
  target: WorkspaceTarget
  // Who showed what's here, as the pane's label names them.
  agent: string
  mail: MailHandle
  peerName: (handle: string) => string | undefined
  presentation: PlanPresentation
  originOf: (member: BarMember) => string | undefined
  // Undocks what's shown into a window of its own.
  onUndock: (member: BarMember) => void
  onHide: () => void
  // Closes what's shown, as the taskbar's menu does, and the pane with it.
  onClose: (member: BarMember) => void
}): React.JSX.Element => {
  const messages = member?.kind === "messages"
  const plan = member?.kind === "item" && member.item.kind === "plan" ? member.item : undefined
  const undock = member?.kind === "item" && !member.placed ? () => onUndock(member) : undefined
  const tab = member && (
    <MemberTab
      key={member.key}
      member={member}
      panes={panes}
      target={target}
      mail={mail}
      peerName={peerName}
      actions={
        <PaneActions
          name={member.kind === "messages" ? "Messages" : member.item.name}
          onUndock={undock}
          onHide={onHide}
          onClose={() => onClose(member)}
        />
      }
    />
  )
  return (
    <section
      className="plan-reader"
      data-workspace-companion
      data-presentation={presentation}
      aria-label={messages ? "Messages" : `What ${agent} showed you`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          onHide()
        }
      }}
      // Leaving the plan saves it at once, so an agent told to re-read it finds the edits.
      onBlur={(event) => {
        if (plan && !event.currentTarget.contains(event.relatedTarget))
          panes.plan(target, plan.id).flush()
      }}
    >
      {!member ? (
        // All that's left may hold secrets, which shows only once picked.
        <div className="artifact-status">Pick what to show from the taskbar.</div>
      ) : member.kind === "item" && member.placed ? (
        <div className="placed-tab">
          <p className="placed-from">From {originOf(member) ?? "another terminal"}</p>
          {tab}
        </div>
      ) : (
        tab
      )}
    </section>
  )
}
