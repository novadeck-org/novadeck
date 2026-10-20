import { createKept, type ViewerState } from "@novadeck/viewers"
import {
  mountMarkdown,
  rowAnnotations,
  type ClassedRange,
  type MarkdownContent,
} from "@novadeck/viewers/markdown"
import { useViewer } from "@novadeck/viewers/react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"

import type { Mark } from "../plan-doc"
import { planNotes, rowNotes } from "./plan-notes"

// What the reader can ask of the editor.
export type PlanEditorHandle = { readonly jumpTo: (at: number) => void }

// What a plan's editor held when it closed, so the next one for that plan, as a view
// switch or a tab Focus no longer keeps builds it again, opens as it was left: the parsed
// file, its undo history and selection, and where it was scrolled.
const savedEditors = createKept<ViewerState>(12)

// The class on the lines the agent's latest revision wrote (see prose.css).
const changed = "cm-plan-changed"

// A plan's notes, as the viewer's extensions: its own, and the one that lets a table's
// rows take them.
const extensions = [planNotes, rowAnnotations.of(rowNotes)]

// The plan file, edited where it's rendered. `text` is the file; the user's edits go out
// through `onChange`, and the agent's rewrites come in as changes to it. `id` names the
// plan, whose editor opens again as the last one for it was left.
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
  onReady: (handle: PlanEditorHandle) => void
  onClose: () => void
  // The plan can't be written: it reads, and takes no edits or notes.
  readOnly?: boolean
}): React.JSX.Element => {
  // The latest props, for the viewer's callbacks, which outlive a render.
  const latest = useRef({ onChange, onReady, onClose })
  useLayoutEffect(() => {
    latest.current = { onChange, onReady, onClose }
  })
  const content = useMemo(
    (): MarkdownContent => ({
      text,
      ranges: marks.map(({ from, to }): ClassedRange => ({ from, to, className: changed })),
    }),
    [text, marks],
  )
  const onEdit = useCallback(
    (edited: string, ranges: readonly ClassedRange[]) =>
      latest.current.onChange(
        edited,
        ranges.map(({ from, to }) => ({ from, to })),
      ),
    [],
  )
  const { ref, viewer } = useViewer(mountMarkdown, {
    id,
    content,
    label: "Plan",
    kept: savedEditors,
    editable: !readOnly,
    onEdit,
    extensions,
  })
  // The plan becoming writable, or not, keeps the editor, its history and its place.
  useEffect(() => viewer?.editable(!readOnly), [viewer, readOnly])
  useEffect(() => {
    if (!viewer) return
    latest.current.onReady({ jumpTo: (at) => viewer.jumpTo({ offset: at }) })
  }, [viewer])
  // Closing the pane leaves no empty note behind: none of the editor's updates follow.
  useEffect(() => () => latest.current.onClose(), [])
  return (
    <div
      ref={ref}
      className="plan-editor nodrag nopan nowheel"
      data-readonly={readOnly || undefined}
    />
  )
}
