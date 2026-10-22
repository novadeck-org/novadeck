import { rowAnnotations, type ClassedRange } from "@novadeck/viewers/markdown"
import { useCallback, useMemo } from "react"

import { MarkdownEditor, type MarkdownEditorHandle } from "../../../document/editor/MarkdownEditor"
import type { Mark } from "../plan-doc"
import { planNotes, rowNotes } from "./plan-notes"

// The class on the lines the agent's latest revision wrote (see prose.css).
const changed = "cm-plan-changed"

// A plan's notes, as the editor's extensions: its own, and the one that lets a table's
// rows take them.
const extensions = [planNotes, rowAnnotations.of(rowNotes)]

// The plan file, edited where it's rendered: a Markdown document with the plan's notes and
// the lines the agent's latest revision wrote. The person's edits go out through
// `onChange`, with those lines moved along with them. `id` names the plan, whose editor
// opens again as the last one for it was left.
export const PlanEditor = ({
  id,
  text,
  marks,
  onChange,
  onReady,
  onClose,
  readOnly = false,
}: {
  id: string
  text: string
  marks: readonly Mark[]
  // The text, and the latest revision's highlights moved along with the edit.
  onChange: (text: string, marks: readonly Mark[]) => void
  onReady: (handle: MarkdownEditorHandle) => void
  onClose: () => void
  // The plan can't be written: it reads, and takes no edits or notes.
  readOnly?: boolean
}): React.JSX.Element => {
  const ranges = useMemo(
    () => marks.map(({ from, to }): ClassedRange => ({ from, to, className: changed })),
    [marks],
  )
  const onEdit = useCallback(
    (edited: string, moved: readonly ClassedRange[]) =>
      onChange(
        edited,
        moved.map(({ from, to }) => ({ from, to })),
      ),
    [onChange],
  )
  return (
    <MarkdownEditor
      id={id}
      text={text}
      label="Plan"
      ranges={ranges}
      extensions={extensions}
      onEdit={onEdit}
      onReady={onReady}
      onClose={onClose}
      readOnly={readOnly}
    />
  )
}
