import type { WorkspaceTarget } from "@novadeck/core/types"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { createLucideIcon, Minus, X } from "lucide-react"
import { useEffect, useRef, type ReactNode } from "react"

import type { BarMember } from "./bar"
import type { MailHandle } from "./panes/messages/mail"
import type { LookContext } from "./registration"
import { registrationOf } from "./registry"
import type { Panes, PlanPresentation } from "./state"

// Windows' restore glyph, drawn as lucide draws: a window lifting off the one it was
// maximized in, as an item docked in the pane lifts into a window of its own.
const Restore = createLucideIcon("restore", [
  ["rect", { x: "3", y: "8", width: "13", height: "13", rx: "2", key: "front" }],
  ["path", { d: "M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3", key: "back" }],
])

// What the pane does with what it shows, at the end of its header, as a window's title
// bar does on Windows: minimizes it back to the taskbar, uncovering what's open behind
// it; undocks it into a window of its own, where it can; and closes it, off the taskbar,
// as the taskbar's menu does. Escape hides the whole pane, which is the same as
// minimizing while nothing's behind.
const PaneActions = ({
  name,
  behind,
  onUndock,
  onMinimize,
  onClose,
}: {
  // What the pane shows, as closing it names it.
  name: string
  // Whether something's open behind it.
  behind: boolean
  onUndock: (() => void) | undefined
  onMinimize: () => void
  onClose: () => void
}): React.JSX.Element => (
  <span className="artifact-actions">
    <Tooltip content={behind ? "Minimize · Esc hides the pane" : "Minimize to the taskbar · Esc"}>
      <button
        type="button"
        className="icon-button"
        aria-label="Minimize to the taskbar"
        onClick={onMinimize}
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
// messages, or another terminal's item placed here, under a line saying whose it is. It's
// the top of what's open in the pane; the rest waits behind it.
export const CompanionPane = ({
  member,
  behind,
  panes,
  target,
  agent,
  mail,
  peerName,
  presentation,
  plans,
  originOf,
  onUndock,
  onMinimize,
  onHide,
  onClose,
}: {
  member: BarMember | undefined
  // How many are open behind it.
  behind: number
  panes: Panes
  target: WorkspaceTarget
  // Who showed what's here, as the pane's label names them.
  agent: string
  mail: MailHandle
  peerName: (handle: string) => string | undefined
  presentation: PlanPresentation
  // The bar's plans, as the taskbar names them.
  plans: LookContext["plans"]
  originOf: (member: BarMember) => string | undefined
  // Undocks what's shown into a window of its own.
  onUndock: (member: BarMember) => void
  // Minimizes what's shown, uncovering what's behind; hides the whole pane, as Escape does.
  onMinimize: (member: BarMember) => void
  onHide: () => void
  // Closes what's shown, as the taskbar's menu does, uncovering what's behind.
  onClose: (member: BarMember) => void
}): React.JSX.Element => {
  const messages = member?.kind === "messages"
  const plan = member?.kind === "item" && member.item.kind === "plan" ? member.item : undefined
  // Minimizing or closing what it showed from inside it drops focus with it: the pane
  // takes it, as the window uncovered takes focus on a desktop. Focus the person has
  // elsewhere stays there.
  const section = useRef<HTMLElement>(null)
  const shown = useRef(member?.key)
  useEffect(() => {
    const before = shown.current
    shown.current = member?.key
    if (before === undefined || before === member?.key) return
    const focused = document.activeElement
    if (!focused || focused === document.body) section.current?.focus({ preventScroll: true })
  }, [member?.key])
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
          name={registrationOf(member).look(member, { plans }).name}
          behind={behind > 0}
          onUndock={undock}
          onMinimize={() => onMinimize(member)}
          onClose={() => onClose(member)}
        />
      }
    />
  )
  return (
    <section
      ref={section}
      tabIndex={-1}
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
