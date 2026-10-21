import type { ChangesContent } from "@novadeck/core/companion"
import { mountDiff, type DiffContent } from "@novadeck/viewers/diff"
import { useMemo } from "react"

import type { ArtifactBodyProps } from "../../ArtifactViewer"
import { useViewerSlot } from "../../ViewerSlot"

const totals = (content: ChangesContent): { added: number; removed: number } => ({
  added: content.files.reduce((sum, file) => sum + file.added, 0),
  removed: content.files.reduce((sum, file) => sum + file.removed, 0),
})

// An agent's change, file by file, in the diff viewer, read-only. Where its viewer was, by
// item, is kept, so a change shown again opens where it was.
export const ChangesViewer = ({
  item,
  content: change,
  actions,
}: ArtifactBodyProps<"changes">): React.JSX.Element => {
  const content = useMemo(
    (): DiffContent => ({ base: change.base, files: change.files, truncated: change.truncated }),
    [change],
  )
  const { ref } = useViewerSlot(mountDiff, { id: item.id, content, label: item.name })
  const { added, removed } = totals(change)
  const count = change.files.length
  return (
    <>
      <div className="artifact-meta">
        <code>{item.name}</code>
        <span>
          {count === 0
            ? `no changes against ${change.base}`
            : `${count} ${count === 1 ? "file" : "files"} · +${added} −${removed} · against ${change.base}`}{" "}
          · read-only
        </span>
        {actions && <span className="artifact-meta-push" />}
        {actions}
      </div>
      <div ref={ref} className="artifact-diff" />
    </>
  )
}

// A change in miniature: how many files and lines it touches, over the first few paths.
export const ChangesThumb = ({ content }: { content: ChangesContent }): React.JSX.Element => {
  const { added, removed } = totals(content)
  const paths = content.files.slice(0, 5)
  return (
    <code className="peek-changes">
      <span>
        {content.files.length === 0
          ? "No changes"
          : `${content.files.length} ${content.files.length === 1 ? "file" : "files"}  +${added} −${removed}`}
      </span>
      {paths.map((file) => (
        <span key={file.path} data-status={file.status}>
          {file.path}
        </span>
      ))}
    </code>
  )
}
