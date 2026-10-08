import { AppWindow, PanelRightClose } from "lucide-react"
import { lazy, Suspense, useRef, type ReactNode } from "react"

import { pathOf, notePattern, notesIn, type CompanionItem } from "../../model/companion"
import type { WorkspaceTarget } from "../../model/types"
import { Tooltip } from "../../ui-toolkit/Tooltip"
import { ArtifactViewer, Unavailable } from "./ArtifactViewer"
import type { BarMember } from "./bar"
import type { MailHandle } from "./mail"
import { MessagesView } from "./MessagesView"
import { currentMarks, type PlanDoc } from "./plan-doc"
import type { PlanEditorHandle } from "./plan-editor/PlanEditor"
import { headingsOf } from "./plan-text"
import type { PlanActions, Panes, PlanPresentation } from "./state"
import { useContent, usePlan } from "./use-panes"

// The editor loads when a plan first opens, so the workspace never pays for it.
const PlanEditor = lazy(() =>
  import("./plan-editor/PlanEditor").then((module) => ({ default: module.PlanEditor })),
)

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`

// The headings in the file, with what the latest revision changed and where notes are.
const PlanOutline = ({
  plan,
  jump,
}: {
  plan: PlanDoc
  jump: (at: number) => void
}): React.JSX.Element | null => {
  const headings = headingsOf(plan.text)
  if (!headings.length) return null
  const marks = plan.showChanges ? currentMarks(plan) : []
  const notes = [...plan.text.matchAll(notePattern)].map((match) => match.index)
  // Each heading's section runs to the next heading.
  const sections = headings.map((heading, index) => ({
    ...heading,
    end: headings[index + 1]?.at ?? plan.text.length,
  }))
  return (
    <nav className="plan-spine" aria-label="Plan outline">
      <p className="plan-spine-label">Contents</p>
      <ul className="plan-spine-context">
        {sections.map((section) => {
          const count = notes.filter((at) => at >= section.at && at < section.end).length
          const changed = marks.some((mark) => mark.from < section.end && mark.to > section.at)
          return (
            <li key={section.at}>
              <button onClick={() => jump(section.at)} data-changed={changed}>
                <span>{section.text}</span>
                {count > 0 && <em aria-label={plural(count, "note")}>{count}</em>}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

// What the pane does with what it shows, at the end of its header: undocks it into a
// window of its own, where it can, and minimizes the pane back to the taskbar, as Escape
// does.
const PaneActions = ({
  onUndock,
  onHide,
}: {
  onUndock: (() => void) | undefined
  onHide: () => void
}): React.JSX.Element => (
  <span className="artifact-actions">
    {onUndock && (
      <Tooltip content="Undock to its own window">
        <button
          type="button"
          className="icon-button"
          aria-label="Undock to its own window"
          onClick={onUndock}
        >
          <AppWindow size={13} strokeWidth={1.75} aria-hidden />
        </button>
      </Tooltip>
    )}
    <Tooltip content="Minimize to the taskbar · Esc">
      <button
        type="button"
        className="icon-button"
        aria-label="Minimize to the taskbar"
        onClick={onHide}
      >
        <PanelRightClose size={13} strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
  </span>
)

// Something an agent showed, as it loads now, followed while it shows.
export const ArtifactTab = ({
  panes,
  target,
  item,
  actions,
}: {
  panes: Panes
  target: WorkspaceTarget
  item: CompanionItem
  // What the place showing it offers, at the end of its header.
  actions?: ReactNode
}): React.JSX.Element => (
  <ArtifactViewer
    artifact={item}
    load={useContent(panes, target, item)}
    actions={actions}
    onReveal={() => panes.reveal(target, item.id)}
  />
)

const PlanBody = ({
  item,
  plan,
  actions,
  pane,
}: {
  item: CompanionItem
  plan: PlanDoc
  actions: ReactNode
  pane: PlanActions
}): React.JSX.Element => {
  const editor = useRef<PlanEditorHandle | null>(null)
  const marks = currentMarks(plan)
  const agent = item.plan?.agent ?? "The agent"
  // The header every viewer has, across the pane, then the outline beside the plan.
  return (
    <>
      <div className="artifact-meta">
        {pathOf(item) === null ? (
          <span>{item.detail || item.name}</span>
        ) : (
          <code>{pathOf(item)}</code>
        )}
        <span>v{item.version}</span>
        {marks.length > 0 && (
          <button
            className="plan-changes-toggle"
            data-tone="warning"
            aria-pressed={plan.showChanges}
            onClick={pane.toggleChanges}
          >
            <i aria-hidden="true" />
            {plural(plan.changes, "change")} since you last read
            <span>{plan.showChanges ? "Hide" : "Show"}</span>
          </button>
        )}
        {plan.unsaved && <span className="plan-meta-hint">Not saved yet. Trying again.</span>}
        {plan.resolved > 0 && plan.marked === plan.text && (
          <span>
            {agent} resolved {plural(plan.resolved, "note")}
          </span>
        )}
        {!plan.writable && (
          <span className="plan-meta-hint">Read-only: Novadeck can't write this plan yet.</span>
        )}
        {plan.truncated && (
          <span className="plan-meta-hint">It's long, so only its start is shown.</span>
        )}
        {/* Without Novadeck's skill, notes wait for the person to point the agent at them. */}
        {plan.writable && !plan.skill && notesIn(plan.text) > 0 && (
          <span className="plan-meta-hint">
            {agent} doesn't have Novadeck's skill. Ask it to re-read the plan.
          </span>
        )}
        {actions && <span className="artifact-meta-push" />}
        {actions}
      </div>
      <div className="plan-reader-body" data-outline={headingsOf(plan.text).length > 0}>
        <PlanOutline plan={plan} jump={(at) => editor.current?.jumpTo(at)} />
        <div className="plan-document-scroll" data-changes={plan.showChanges}>
          <Suspense fallback={null}>
            <PlanEditor
              readOnly={!plan.writable}
              text={plan.text}
              marks={marks}
              onChange={pane.edit}
              onReady={(handle) => {
                editor.current = handle
              }}
              onClose={pane.closeEditor}
            />
          </Suspense>
        </div>
      </div>
    </>
  )
}

// One plan, edited where it's read, with its outline: in the pane, or in a window of its
// own once undocked. Or why it can't show, once its plan is gone.
export const PlanTab = ({
  panes,
  target,
  item,
  actions,
}: {
  panes: Panes
  target: WorkspaceTarget
  item: CompanionItem
  // What the place showing the plan offers, at the end of its header.
  actions?: ReactNode
}): React.JSX.Element => {
  const plan = usePlan(panes, item.id)
  const content = useContent(panes, target, item)
  if (content?.state === "unavailable")
    return <Unavailable item={item} reason={content.reason} size={content.size} actions={actions} />
  return plan ? (
    // A plan that becomes writable, or stops being so, starts its editor over.
    <PlanBody
      key={String(plan.writable)}
      item={item}
      plan={plan}
      actions={actions}
      pane={panes.plan(target, item.id)}
    />
  ) : (
    <div className="artifact-status" />
  )
}

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
  if (member.kind === "messages")
    return <MessagesView mail={mail} peerName={peerName} actions={actions} />
  return member.item.kind === "plan" ? (
    <PlanTab panes={panes} target={target} item={member.item} actions={actions} />
  ) : (
    <ArtifactTab panes={panes} target={target} item={member.item} actions={actions} />
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
      actions={<PaneActions onUndock={undock} onHide={onHide} />}
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
