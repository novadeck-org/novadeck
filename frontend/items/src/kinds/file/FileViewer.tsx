import type { Item, FileContent } from "@novadeck/core/items"
import { mountCode, type CodeContent } from "@novadeck/viewers/code"
import { useMemo } from "react"

import type { ArtifactBodyProps } from "../../ArtifactViewer"
import { OutlineThumb } from "../../document/OutlineThumb"
import { useViewerSlot } from "../../ViewerSlot"
import { DocumentViewer } from "./DocumentViewer"
import { isMarkdown } from "./markdown"

// A text file, as plain text at once, then highlighted when its language is one Novadeck
// knows, in the code viewer. Where its viewer was, by item, is kept, so a file shown again
// opens where it was.
const CodeViewer = ({
  id,
  content: artifact,
  actions,
}: Pick<ArtifactBodyProps<"file">, "actions" | "content"> & {
  id: Item["id"]
}): React.JSX.Element => {
  const content = useMemo(
    (): CodeContent => ({
      lines: artifact.lines,
      firstLine: artifact.firstLine,
      path: artifact.path,
      // The lines the agent pointed at.
      emphasis: { from: artifact.from, to: artifact.to },
    }),
    [artifact],
  )
  const { ref: code } = useViewerSlot(mountCode, {
    id,
    content,
    label: artifact.path,
  })
  return (
    <>
      <div className="artifact-meta">
        <code>{artifact.path}</code>
        <span>
          lines {artifact.from}–{artifact.to} · read-only
        </span>
        {artifact.clamped && <span>The file ends at line {artifact.to}.</span>}
        {artifact.truncated && <span>It's long, so only its start is shown.</span>}
        {actions && <span className="artifact-meta-push" />}
        {actions}
      </div>
      <div ref={code} className="artifact-code" />
    </>
  )
}

// A file: its markdown reads as a document, formatted as a plan is; anything else as code.
export const FileViewer = ({
  item,
  content,
  actions,
}: ArtifactBodyProps<"file">): React.JSX.Element =>
  isMarkdown(content.path) ? (
    <DocumentViewer id={item.id} name={item.name} content={content} actions={actions} />
  ) : (
    <CodeViewer id={item.id} content={content} actions={actions} />
  )

// The lines the agent pointed at, from the first one on.
const pointedLines = (file: FileContent): readonly string[] =>
  file.lines.slice(file.from - file.firstLine, file.to - file.firstLine + 1)

// A document in miniature, as a plan is: its title over its sections. Code: the lines the
// agent pointed at.
export const FileThumb = ({ content }: { content: FileContent }): React.JSX.Element =>
  isMarkdown(content.path) ? (
    <OutlineThumb path={content.path} text={content.lines.join("\n")} />
  ) : (
    <code className="peek-code">{pointedLines(content).join("\n")}</code>
  )
