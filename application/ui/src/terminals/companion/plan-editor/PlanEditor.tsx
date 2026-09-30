import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { Language, LanguageSupport, defineLanguageFacet } from "@codemirror/language"
import { Annotation, EditorState, Transaction } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { GFM, parser } from "@lezer/markdown"
import { useEffect, useLayoutEffect, useRef } from "react"

import type { Mark } from "../state"
import { currentAgentMarks, livePreview, setMarks } from "./live-preview"
import { lineChanges } from "./sync"

// Markdown with GitHub's tables and task lists, and nothing embedded: plans don't need
// HTML, CSS or JavaScript highlighting, which would triple the editor's size.
const planMarkdown = new LanguageSupport(
  new Language(defineLanguageFacet(), parser.configure(GFM), [], "markdown"),
)

// Marks the agent's rewrites, which are not the user's edits.
const fromAgent = Annotation.define<boolean>()

// What the reader can ask of the editor.
export type PlanEditorHandle = { readonly jumpTo: (at: number) => void }

// The plan file, edited where it's rendered. `text` is the file; the user's edits go out
// through `onChange`, and the agent's rewrites come in as changes to it.
export const PlanEditor = ({
  text,
  marks,
  onChange,
  onReady,
  onClose,
}: {
  text: string
  marks: readonly Mark[]
  // The text, and the latest revision's highlights moved along with the edit.
  onChange: (text: string, marks: readonly Mark[]) => void
  onReady: (handle: PlanEditorHandle) => void
  onClose: () => void
}): React.JSX.Element => {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // The latest props, for the editor's listeners, which outlive a render.
  const latest = useRef({ text, marks, onChange, onReady, onClose })
  useLayoutEffect(() => {
    latest.current = { text, marks, onChange, onReady, onClose }
  })
  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current.text,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          planMarkdown,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": "Plan" }),
          livePreview,
          EditorView.updateListener.of((update) => {
            if (
              update.transactions.some(
                (transaction) => transaction.docChanged && !transaction.annotation(fromAgent),
              )
            )
              latest.current.onChange(update.state.doc.toString(), currentAgentMarks(update.state))
          }),
        ],
      }),
    })
    editor.dispatch({ effects: setMarks.of(latest.current.marks) })
    view.current = editor
    latest.current.onReady({
      jumpTo: (at) =>
        editor.dispatch({ effects: EditorView.scrollIntoView(at, { y: "start", yMargin: 24 }) }),
    })
    return () => {
      // Closing the pane leaves no empty note behind: none of the editor's updates follow.
      latest.current.onClose()
      editor.destroy()
    }
  }, [])
  // The file changed outside the editor: apply the difference, keeping the cursor. It
  // isn't the user's to undo: undoing it would only write the old plan back.
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const doc = editor.state.doc.toString()
    if (doc === text) return
    editor.dispatch({
      changes: lineChanges(doc, text),
      effects: setMarks.of(marks),
      annotations: [fromAgent.of(true), Transaction.addToHistory.of(false)],
    })
  }, [text, marks])
  return <div ref={host} className="plan-editor nodrag nopan nowheel" />
}
