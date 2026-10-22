import type { FileContent } from "@novadeck/core/items"
import { outline } from "@novadeck/viewers/text"
import { useRef, type ReactNode } from "react"

import { ArtifactMeta, MetaPath } from "../../ArtifactViewer"
import type { MarkdownEditorHandle } from "../../document/editor/MarkdownEditor"
import { MarkdownDocument } from "../../document/MarkdownDocument"

// A markdown file the agent showed, as a document, read-only: formatted, with its outline,
// as a plan reads, but it's the agent's file, not something to edit or note.

export const DocumentViewer = ({
  id,
  name,
  content,
  actions,
}: {
  // The item showing it, whose editor opens again as it was left.
  id: string
  // The item's name, which labels the document: it reads as the file, not as a plan.
  name: string
  content: FileContent
  actions?: ReactNode
}): React.JSX.Element => {
  const editor = useRef<MarkdownEditorHandle | null>(null)
  const text = content.lines.join("\n")
  const headings = outline(text)
  return (
    <div className="plan-reader artifact-document">
      <ArtifactMeta actions={actions}>
        <MetaPath path={content.path} />
        <span>read-only</span>
        {content.truncated && (
          <span className="plan-meta-hint">It's long, so only its start is shown.</span>
        )}
      </ArtifactMeta>
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
          <MarkdownDocument
            id={id}
            readOnly
            text={text}
            label={name}
            onReady={(handle) => {
              editor.current = handle
            }}
          />
        </div>
      </div>
    </div>
  )
}
