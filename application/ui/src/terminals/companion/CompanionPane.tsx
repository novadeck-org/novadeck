import { lazy, Suspense, useRef } from "react"

import { notePattern, notesIn } from "../../model/companion"
import { ArtifactViewer } from "./ArtifactViewer"
import type { PlanEditorHandle } from "./plan-editor/PlanEditor"
import { headingsOf } from "./plan-text"
import {
  closePlan,
  currentMarks,
  toggleChanges,
  type CompanionHandle,
  type PlanPresentation,
  type PlanState,
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
  plan: PlanState
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

// A terminal's companion pane, wherever it is presented: its plan, edited where it's
// read, or one of the other things its agent showed the user.
export const CompanionPane = ({
  companion,
  presentation,
}: {
  companion: CompanionHandle
  presentation: PlanPresentation
}): React.JSX.Element => {
  const { state: plan, plan: file } = companion
  const editor = useRef<PlanEditorHandle | null>(null)
  const marks = currentMarks(plan)
  const artifact = plan.artifacts.find((shown) => shown.id === plan.tab)
  return (
    <section
      className="plan-reader"
      data-workspace-companion
      data-presentation={presentation}
      aria-label={`What ${file.agent} showed you`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          companion.update(closePlan)
        }
      }}
    >
      {artifact ? (
        <ArtifactViewer key={artifact.id} artifact={artifact} />
      ) : (
        <div className="plan-reader-body" data-outline={headingsOf(plan.text).length > 0}>
          <PlanOutline plan={plan} jump={(at) => editor.current?.jumpTo(at)} />
          <div className="plan-document-scroll" data-changes={plan.showChanges}>
            <div className="plan-meta">
              <code className="plan-meta-path">{file.path}</code>
              <span>
                v{plan.revision + 1} · {plan.revision ? "updated just now" : "written 2 min ago"}
              </span>
              {marks.length > 0 && (
                <button
                  className="plan-changes-toggle"
                  aria-pressed={plan.showChanges}
                  onClick={() => companion.update(toggleChanges)}
                >
                  <i aria-hidden="true" />
                  {plural(plan.changes, "change")} since you last read
                  <span>{plan.showChanges ? "Hide" : "Show"}</span>
                </button>
              )}
              {plan.resolved > 0 && plan.marked === plan.text && (
                <span>
                  {file.agent} resolved {plural(plan.resolved, "note")}
                </span>
              )}
              {/* Without NovaDeck's skill, notes wait for the user to point the agent at them. */}
              {!file.skill && notesIn(plan.text) > 0 && (
                <span className="plan-meta-hint">
                  {file.agent} doesn't have NovaDeck's skill. Ask it to re-read the plan.
                </span>
              )}
            </div>
            <Suspense fallback={null}>
              <PlanEditor
                text={plan.text}
                marks={marks}
                onChange={companion.edit}
                onReady={(handle) => {
                  editor.current = handle
                }}
                onClose={companion.dropEmptyNotes}
              />
            </Suspense>
          </div>
        </div>
      )}
    </section>
  )
}
