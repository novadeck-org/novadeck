import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { Language, LanguageSupport, defineLanguageFacet } from "@codemirror/language"
import { Annotation, EditorState, MapMode, Transaction } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { GFM, parser } from "@lezer/markdown"
import { createKept } from "@novadeck/viewers"
import { useEffect, useLayoutEffect, useRef } from "react"

import type { Mark } from "../plan-doc"
import { editorTheme } from "./editor-theme"
import { currentAgentMarks, livePreview, setMarks } from "./live-preview"
import {
  followScroll,
  restoreScroll,
  scrollLineToTop,
  type PlanScroll,
  type ScrollRestore,
} from "./scroll"
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

// What follows an editor: its latest listeners, and where its pane is scrolled in the
// plan, moved along with every change to it. A saved state outlives the editor that made
// it, so its extensions reach these through the editor showing it now.
type Followers = {
  readonly listeners: {
    readonly current: { readonly onChange: (text: string, marks: readonly Mark[]) => void }
  }
  scroll: PlanScroll | null
  restore: ScrollRestore | null
}
const followersOf = new WeakMap<EditorView, Followers>()

// What a plan's editor held when it closed, so the next one for that plan, as a view
// switch or a tab Focus no longer keeps builds it again, opens as it was left: the parsed
// file, its undo history and selection, and where it was scrolled. Kept here, so a hot
// update of the editor starts over rather than reopening states the new code can't follow.
type SavedEditor = { readonly state: EditorState; readonly scroll: PlanScroll | null }
const savedEditors = createKept<SavedEditor>(12)

// The editor's behaviour, fixed for a state's life: the pane remounts the editor, and
// starts a new state, if the plan becomes writable or stops being so.
const extensions = (readOnly: boolean) => [
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  planMarkdown,
  EditorView.lineWrapping,
  EditorState.readOnly.of(readOnly),
  // Read-only holds for every change, not only typing: note keys, checkboxes and the
  // table's own edits dispatch directly. Only the file's own changes land.
  EditorState.transactionFilter.of((transaction) =>
    transaction.docChanged && transaction.startState.readOnly && !transaction.annotation(fromAgent)
      ? []
      : transaction,
  ),
  EditorView.contentAttributes.of({ "aria-label": "Plan" }),
  livePreview,
  editorTheme,
  EditorView.updateListener.of((update) => {
    const followers = followersOf.get(update.view)
    if (!followers) return
    if (update.geometryChanged) followers.restore?.layout()
    if (!update.docChanged) return
    const { scroll } = followers
    // Inserted right above, the line stays; rewritten, the place is where the rewrite starts.
    if (scroll)
      followers.scroll = {
        ...scroll,
        at:
          update.changes.mapPos(scroll.at, 1, MapMode.TrackDel) ??
          update.changes.mapPos(scroll.at, -1),
      }
    if (
      update.transactions.some(
        (transaction) => transaction.docChanged && !transaction.annotation(fromAgent),
      )
    )
      followers.listeners.current.onChange(
        update.state.doc.toString(),
        currentAgentMarks(update.state),
      )
  }),
]

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
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // The latest props, for the editor's listeners, which outlive a render.
  const latest = useRef({ id, text, marks, onChange, onReady, onClose, readOnly })
  useLayoutEffect(() => {
    latest.current = { id, text, marks, onChange, onReady, onClose, readOnly }
  })
  useEffect(() => {
    const { id: plan, text: doc, readOnly: locked } = latest.current
    const saved = savedEditors.get(plan)
    const reopened = saved?.state.readOnly === locked ? saved : undefined
    const editor = new EditorView({
      parent: host.current!,
      state: reopened?.state ?? EditorState.create({ doc, extensions: extensions(locked) }),
    })
    const followers: Followers = {
      listeners: latest,
      scroll: reopened?.scroll ?? null,
      restore: null,
    }
    followersOf.set(editor, followers)
    editor.dispatch({ effects: setMarks.of(latest.current.marks) })
    // Where the pane is scrolled counts once it's back where it was left.
    let stopScroll = (): void => {}
    let closing = false
    const follow = (): void => {
      // A restore ended by closing leaves the place it was restoring to.
      if (closing) return
      stopScroll = followScroll(editor, (at) => {
        followers.scroll = at
      })
    }
    let stopRestore = (): void => {}
    if (followers.scroll) {
      followers.restore = restoreScroll(editor, () => followers.scroll, follow)
      stopRestore = followers.restore.stop
    } else follow()
    view.current = editor
    latest.current.onReady({
      // A jump from the outline wins over a restore still under way.
      jumpTo: (at) => {
        stopRestore()
        scrollLineToTop(editor, at)
      },
    })
    return () => {
      // Closing the pane leaves no empty note behind: none of the editor's updates follow.
      latest.current.onClose()
      closing = true
      stopRestore()
      stopScroll()
      savedEditors.keep(plan, { state: editor.state, scroll: followers.scroll })
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
  return (
    <div
      ref={host}
      className="plan-editor nodrag nopan nowheel"
      data-readonly={readOnly || undefined}
    />
  )
}
