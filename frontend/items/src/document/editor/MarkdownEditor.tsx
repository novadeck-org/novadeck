import { createKept, type ViewerState } from "@novadeck/viewers"
import {
  mountMarkdown,
  type ClassedRange,
  type MarkdownContent,
  type MarkdownOptions,
} from "@novadeck/viewers/markdown"
import { useViewer } from "@novadeck/viewers/react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"

// What the reader can ask of the editor.
export type MarkdownEditorHandle = { readonly jumpTo: (at: number) => void }

// What a document's editor held when it closed, so the next one for that document, as a
// view switch or a tab Focus no longer keeps builds it again, opens as it was left: the
// parsed text, its undo history and selection, and where it was scrolled. One store for
// every document, a plan's or a file's, by the item showing it.
const savedEditors = createKept<ViewerState>(12)

const none: readonly ClassedRange[] = []
const plain: NonNullable<MarkdownOptions["extensions"]> = []
const ignore = (): void => {}

// What a document's editor is given. `text` is the document; the person's edits go out
// through `onEdit`, and outside changes come in as changes to it. `id` names the document,
// whose editor opens again as the last one for it was left. What a kind adds to a
// document, as a plan its notes, comes in as `extensions`, which it loads with its editor.
export type MarkdownEditorProps = {
  id: string
  text: string
  // How the editable text reads to assistive technology.
  label: string
  // Classes on lines, which edits move along with the text.
  ranges?: readonly ClassedRange[]
  extensions?: MarkdownOptions["extensions"]
  // The text, and the ranges moved along with the edit.
  onEdit?: (text: string, ranges: readonly ClassedRange[]) => void
  onReady: (handle: MarkdownEditorHandle) => void
  onClose?: () => void
  // The document can't be written: it reads, and takes no edits.
  readOnly?: boolean
}

// A Markdown document, formatted where it's read: edited there, or read-only. It loads
// lazily (see ../MarkdownDocument.tsx), CodeMirror with it.
export const MarkdownEditor = ({
  id,
  text,
  label,
  ranges = none,
  extensions = plain,
  onEdit = ignore,
  onReady,
  onClose = ignore,
  readOnly = false,
}: MarkdownEditorProps): React.JSX.Element => {
  // The latest props, for the viewer's callbacks, which outlive a render.
  const latest = useRef({ onEdit, onReady, onClose })
  useLayoutEffect(() => {
    latest.current = { onEdit, onReady, onClose }
  })
  const content = useMemo((): MarkdownContent => ({ text, ranges }), [text, ranges])
  const edited = useCallback(
    (next: string, moved: readonly ClassedRange[]) => latest.current.onEdit(next, moved),
    [],
  )
  const { ref, viewer } = useViewer(mountMarkdown, {
    id,
    content,
    label,
    kept: savedEditors,
    editable: !readOnly,
    onEdit: edited,
    extensions,
  })
  // The document becoming writable, or not, keeps the editor, its history and its place.
  useEffect(() => viewer?.editable(!readOnly), [viewer, readOnly])
  useEffect(() => {
    if (!viewer) return
    latest.current.onReady({ jumpTo: (at) => viewer.jumpTo({ offset: at }) })
  }, [viewer])
  // Closing it leaves nothing behind: none of the editor's updates follow.
  useEffect(() => () => latest.current.onClose(), [])
  return (
    <div
      ref={ref}
      className="document-editor nodrag nopan nowheel"
      data-readonly={readOnly || undefined}
    />
  )
}
