import type { FileContent } from "@novadeck/core/items"
import { createKept, type Kept, type ViewerState } from "@novadeck/viewers"
import { outline } from "@novadeck/viewers/text"
import { useMemo, useRef, type ReactNode } from "react"

import { ArtifactMeta, MetaPath } from "../../ArtifactViewer"
import type { MarkdownEditorHandle } from "../../document/editor/MarkdownEditor"
import { MarkdownDocument } from "../../document/MarkdownDocument"

// Where each file's editor was left, by the item showing it, with the file it showed: the
// same item shown another file, as the project window's is when the person opens one, opens
// that one at its top, as the code viewer does. Apart from the plans', so browsing files
// never pushes a plan's history out.
const savedFiles = createKept<{ readonly path: string; readonly state: ViewerState }>(12)

// The files' store as an editor showing `path` keeps it.
const keptFor = (path: string): Kept<ViewerState> => ({
  get: (id) => {
    const saved = savedFiles.get(id)
    return saved?.path === path ? saved.state : undefined
  },
  keep: (id, state) => savedFiles.keep(id, { path, state }),
})

// A Markdown file the agent showed, as a document, read-only: formatted, with its outline.
// It's the agent's file, not something to edit or note.
export const DocumentViewer = ({
  id,
  name,
  content,
  actions,
}: {
  // The item showing it, whose editor opens again as it was left, while it shows this file.
  id: string
  // The item's name, which labels the document: it reads as the file.
  name: string
  content: FileContent
  actions?: ReactNode
}): React.JSX.Element => {
  const editor = useRef<MarkdownEditorHandle | null>(null)
  const kept = useMemo(() => keptFor(content.path), [content.path])
  const text = content.lines.join("\n")
  const headings = outline(text)
  return (
    <div className="pane-reader artifact-document">
      <ArtifactMeta actions={actions}>
        <MetaPath path={content.path} />
        <span>read-only</span>
        {content.truncated && (
          <span className="pane-meta-hint">It's long, so only its start is shown.</span>
        )}
      </ArtifactMeta>
      <div className="pane-reader-body" data-outline={headings.length > 0}>
        {headings.length > 0 && (
          <nav className="spine" aria-label="Document outline">
            <p className="spine-label">Contents</p>
            <ul className="spine-context">
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
        <div className="pane-document-scroll">
          <MarkdownDocument
            id={id}
            kept={kept}
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
