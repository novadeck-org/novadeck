import { AppWindow } from "lucide-react"
import { lazy, Suspense, useRef, type ReactNode } from "react"

import { notePattern, notesIn, type ArtifactContent } from "../../model/companion"
import { ArtifactViewer } from "./ArtifactViewer"
import type { BarMember } from "./bar"
import type { MailHandle } from "./mail"
import { MessagesView } from "./MessagesView"
import { closePane, toggleChanges, type Shown } from "./pane"
import { currentMarks, type PlanDoc } from "./plan-doc"
import type { PlanEditorHandle } from "./plan-editor/PlanEditor"
import { headingsOf } from "./plan-text"
import type { PaneActions, Panes, PlanPresentation } from "./state"
import { useArtifactContent, type PaneHandle } from "./use-panes"

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

// Undocks what the pane shows into a window of its own, at the end of its header.
const UndockButton = ({ onUndock }: { onUndock: () => void }): React.JSX.Element => (
  <span className="artifact-actions">
    <button
      type="button"
      aria-label="Undock to its own window"
      title="Undock to its own window"
      onClick={onUndock}
    >
      <AppWindow size={13} strokeWidth={1.75} aria-hidden />
    </button>
  </span>
)

const ArtifactTab = ({
  load,
  artifact,
  onUndock,
}: {
  load: (artifact: Shown) => Promise<ArtifactContent>
  artifact: Shown
  onUndock: (() => void) | undefined
}): React.JSX.Element => (
  <ArtifactViewer
    artifact={artifact}
    load={useArtifactContent(load, artifact)}
    actions={onUndock && <UndockButton onUndock={onUndock} />}
  />
)

// One plan, edited where it's read, with its outline: in the pane, or in a window of its
// own once undocked.
export const PlanTab = ({
  pane,
  plan,
  actions,
}: {
  // The plan's terminal's pane, which its edits save through.
  pane: PaneActions
  plan: PlanDoc
  // What the place showing the plan offers, at the end of its header.
  actions?: ReactNode
}): React.JSX.Element => {
  const editor = useRef<PlanEditorHandle | null>(null)
  const marks = currentMarks(plan)
  return (
    <div className="plan-reader-body" data-outline={headingsOf(plan.text).length > 0}>
      <PlanOutline plan={plan} jump={(at) => editor.current?.jumpTo(at)} />
      <div className="plan-document-scroll" data-changes={plan.showChanges}>
        <div className="plan-meta">
          <code className="plan-meta-path">{plan.path}</code>
          <span>v{plan.writes + 1}</span>
          {marks.length > 0 && (
            <button
              className="plan-changes-toggle"
              aria-pressed={plan.showChanges}
              onClick={() => pane.update((current) => toggleChanges(current, plan.ref))}
            >
              <i aria-hidden="true" />
              {plural(plan.changes, "change")} since you last read
              <span>{plan.showChanges ? "Hide" : "Show"}</span>
            </button>
          )}
          {plan.unsaved && <span className="plan-meta-hint">Not saved yet. Trying again.</span>}
          {plan.resolved > 0 && plan.marked === plan.text && (
            <span>
              {plan.agent} resolved {plural(plan.resolved, "note")}
            </span>
          )}
          {!plan.writable && (
            <span className="plan-meta-hint">Read-only: NovaDeck can't write this plan yet.</span>
          )}
          {plan.truncated && (
            <span className="plan-meta-hint">It's long, so only its start is shown.</span>
          )}
          {/* Without NovaDeck's skill, notes wait for the user to point the agent at them. */}
          {plan.writable && !plan.skill && notesIn(plan.text) > 0 && (
            <span className="plan-meta-hint">
              {plan.agent} doesn't have NovaDeck's skill. Ask it to re-read the plan.
            </span>
          )}
          {actions && <span className="plan-meta-actions">{actions}</span>}
        </div>
        <Suspense fallback={null}>
          <PlanEditor
            readOnly={!plan.writable}
            text={plan.text}
            marks={marks}
            onChange={(text, moved) => pane.edit(plan.ref, text, moved)}
            onReady={(handle) => {
              editor.current = handle
            }}
            onClose={() => pane.closeEditor(plan.ref)}
          />
        </Suspense>
      </div>
    </div>
  )
}

// What the pane shows of one item on the bar, through its own terminal's pane.
const MemberTab = ({
  member,
  panes,
  mail,
  peerName,
  onUndock,
}: {
  member: BarMember
  panes: Panes
  mail: MailHandle
  peerName: (handle: string) => string | undefined
  onUndock: (() => void) | undefined
}): React.JSX.Element => {
  const { content } = member
  const source = panes.of(member.source)
  return content.kind === "plan" ? (
    <PlanTab
      key={`${content.plan.ref}:${content.plan.writable}`}
      pane={source}
      plan={content.plan}
      actions={onUndock && <UndockButton onUndock={onUndock} />}
    />
  ) : content.kind === "artifact" ? (
    <ArtifactTab
      key={`${content.artifact.id}@${content.artifact.version}`}
      load={source.load}
      artifact={content.artifact}
      onUndock={onUndock}
    />
  ) : (
    <MessagesView mail={mail} peerName={peerName} />
  )
}

// A terminal's companion pane, wherever it is presented: what it shows of the terminal's
// taskbar, `member`: one of its plans, edited where it's read, something its agent showed,
// its messages, or another terminal's item placed here, under a line saying whose it is.
export const CompanionPane = ({
  pane,
  member,
  panes,
  mail,
  peerName,
  presentation,
  originOf,
  onUndock,
}: {
  // This terminal's pane.
  pane: PaneHandle
  member: BarMember | undefined
  panes: Panes
  mail: MailHandle
  peerName: (handle: string) => string | undefined
  presentation: PlanPresentation
  originOf: (member: BarMember) => string
  // Undocks what's shown into a window of its own.
  onUndock: (member: BarMember) => void
}): React.JSX.Element => {
  const messages = member?.content.kind === "messages"
  const plan = member?.content.kind === "plan" ? member.content.plan : undefined
  const agent = pane.pane.plans[0]?.agent ?? "The agent"
  const undock =
    member && !member.placed && !messages && onUndock ? () => onUndock(member) : undefined
  const tab = member && (
    <MemberTab
      key={member.id}
      member={member}
      panes={panes}
      mail={mail}
      peerName={peerName}
      onUndock={undock}
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
          pane.update(closePane)
        }
      }}
      // Leaving the plan saves it at once, so an agent told to re-read it finds the edits.
      onBlur={(event) => {
        if (member && plan && !event.currentTarget.contains(event.relatedTarget))
          panes.of(member.source).flush(plan.ref)
      }}
    >
      {!member ? (
        // All that's left may hold secrets, which shows only once picked.
        <div className="artifact-status">Pick what to show from the taskbar.</div>
      ) : member.placed ? (
        <div className="placed-tab">
          <p className="placed-from">From {originOf(member)}</p>
          {tab}
        </div>
      ) : (
        tab
      )}
    </section>
  )
}
