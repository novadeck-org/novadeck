import { lazy, Suspense, useRef, type ReactNode } from "react"

import type { FileContent } from "../../model/companion"
import type { PlanEditorHandle } from "./plan-editor/PlanEditor"
import { headingsOf } from "./plan-text"

// The plan's editor, read-only: a markdown document the agent showed reads as a plan does,
// formatted, with its outline, but it's the agent's file, not something to edit or note.
const PlanEditor = lazy(() =>
  import("./plan-editor/PlanEditor").then((module) => ({ default: module.PlanEditor })),
)

const noMarks: readonly never[] = []
const ignore = (): void => {}

export const DocumentViewer = ({
  content,
  actions,
}: {
  content: FileContent
  actions?: ReactNode
}): React.JSX.Element => {
  const editor = useRef<PlanEditorHandle | null>(null)
  const text = content.lines.join("\n")
  const headings = headingsOf(text)
  return (
    <div className="plan-reader artifact-document">
      <div className="artifact-meta">
        <code>{content.path}</code>
        <span>read-only</span>
        {content.truncated && (
          <span className="plan-meta-hint">It's long, so only its start is shown.</span>
        )}
        {actions && <span className="artifact-meta-push" />}
        {actions}
      </div>
      <div className="plan-reader-body" data-outline={headings.length > 0}>
        {headings.length > 0 && (
          <nav className="plan-spine" aria-label="Document outline">
            <p className="plan-spine-label">Contents</p>
            <ul className="plan-spine-context">
              {headings.map((heading) => (
                <li key={heading.at}>
                  <button onClick={() => editor.current?.jumpTo(heading.at)}>
                    <span>{heading.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className="plan-document-scroll">
          <Suspense fallback={null}>
            <PlanEditor
              readOnly
              text={text}
              marks={noMarks}
              onChange={ignore}
              onReady={(handle) => {
                editor.current = handle
              }}
              onClose={ignore}
            />
          </Suspense>
        </div>
      </div>
    </div>
  )
}
