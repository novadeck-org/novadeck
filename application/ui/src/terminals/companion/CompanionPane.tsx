import { lazy, Suspense, useRef } from "react"

import { notePattern, notesIn } from "../../model/companion"
import { ArtifactViewer } from "./ArtifactViewer"
import { planRefOf, type Shown } from "./pane"
import type { PlanEditorHandle } from "./plan-editor/PlanEditor"
import { headingsOf } from "./plan-text"
import {
  closePane,
  currentMarks,
  shownTab,
  toggleChanges,
  useArtifactContent,
  type CompanionHandle,
  type PlanDoc,
  type PlanPresentation,
} from "./state"

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

const ArtifactTab = ({
  companion,
  artifact,
}: {
  companion: CompanionHandle
  artifact: Shown
}): React.JSX.Element => (
  <ArtifactViewer artifact={artifact} load={useArtifactContent(companion, artifact)} />
)

const PlanTab = ({
  companion,
  plan,
}: {
  companion: CompanionHandle
  plan: PlanDoc
}): React.JSX.Element => {
  const editor = useRef<PlanEditorHandle | null>(null)
  const marks = currentMarks(plan)
  return (
    <div className="plan-reader-body" data-outline={headingsOf(plan.text).length > 0}>
      <PlanOutline plan={plan} jump={(at) => editor.current?.jumpTo(at)} />
      <div className="plan-document-scroll" data-changes={plan.showChanges}>
        <div className="plan-meta">
          <code className="plan-meta-path">{plan.path}</code>
          <span>
            v{plan.writes + 1} · {plan.writes ? "updated just now" : "written 2 min ago"}
          </span>
          {marks.length > 0 && (
            <button
              className="plan-changes-toggle"
              aria-pressed={plan.showChanges}
              onClick={() => companion.update((pane) => toggleChanges(pane, plan.ref))}
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
          {/* Without NovaDeck's skill, notes wait for the user to point the agent at them. */}
          {!plan.skill && notesIn(plan.text) > 0 && (
            <span className="plan-meta-hint">
              {plan.agent} doesn't have NovaDeck's skill. Ask it to re-read the plan.
            </span>
          )}
        </div>
        <Suspense fallback={null}>
          <PlanEditor
            text={plan.text}
            marks={marks}
            onChange={(text, moved) => companion.edit(plan.ref, text, moved)}
            onReady={(handle) => {
              editor.current = handle
            }}
            onClose={() => companion.closeEditor(plan.ref)}
          />
        </Suspense>
      </div>
    </div>
  )
}

// A terminal's companion pane, wherever it is presented: one of its plans, edited where
// it's read, or one of the other things its agent showed the user.
export const CompanionPane = ({
  companion,
  presentation,
}: {
  companion: CompanionHandle
  presentation: PlanPresentation
}): React.JSX.Element => {
  const { pane } = companion
  const tab = shownTab(pane)
  const ref = planRefOf(tab)
  const plan = pane.plans.find((candidate) => candidate.ref === ref)
  const artifact = pane.artifacts.find((shown) => shown.id === tab)
  const agent = pane.plans[0]?.agent ?? "The agent"
  return (
    <section
      className="plan-reader"
      data-workspace-companion
      data-presentation={presentation}
      aria-label={`What ${agent} showed you`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          companion.update(closePane)
        }
      }}
      // Leaving the plan saves it at once, so an agent told to re-read it finds the edits.
      onBlur={(event) => {
        if (plan && !event.currentTarget.contains(event.relatedTarget)) companion.flush(plan.ref)
      }}
    >
      {plan ? (
        <PlanTab key={plan.ref} companion={companion} plan={plan} />
      ) : artifact ? (
        <ArtifactTab
          key={`${artifact.id}@${artifact.version}`}
          companion={companion}
          artifact={artifact}
        />
      ) : null}
    </section>
  )
}
