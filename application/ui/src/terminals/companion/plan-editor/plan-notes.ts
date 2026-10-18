import { EditorSelection, EditorState, Prec, type Extension, type Range } from "@codemirror/state"
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  highlightActiveLineGutter,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view"
import type { RowAnnotations } from "@novadeck/viewers/markdown"

import { noteClose, noteOpen, notePattern, noteSafe } from "#core/companion"

import {
  addNote,
  caretInNote,
  emptyNoteRemovals,
  inNoteText,
  leaveNote,
  noteIcon,
  noteInput,
  noteLabel,
  notesReopened,
} from "./notes"

// A plan's notes in the markdown viewer: a note is an HTML comment Novadeck writes into
// the plan, shown as a labelled bubble with its wrapper hidden, added from the margin or
// the keyboard, and kept to one line with no `-->` in it. A table row's note is the
// viewer's row annotation.

class NoteLabel extends WidgetType {
  override eq(): boolean {
    return true
  }
  override toDOM(): HTMLElement {
    return noteLabel()
  }
}

const hide = Decoration.replace({})
const label = Decoration.replace({ widget: new NoteLabel() })
const line = (className: string) => Decoration.line({ class: className })
const mark = (className: string) => Decoration.mark({ class: className })

type Rendered = { decorations: DecorationSet; atomic: DecorationSet }

// Notes are Novadeck's own convention, not Markdown, so they're found in the text. Their
// wrapper never shows: a note reads and edits the same, as a labelled line.
const decorate = (view: EditorView): Rendered => {
  const { doc } = view.state
  const ranges: Range<Decoration>[] = []
  // Ranges the cursor steps over whole, and Backspace removes whole.
  const atomic: Range<Decoration>[] = []
  for (const { from, to } of view.visibleRanges) {
    const text = doc.sliceString(from, to)
    for (const match of text.matchAll(notePattern)) {
      const start = from + match.index
      const end = start + match[0].length
      const body = start + noteOpen.length
      const close = end - noteClose.length
      ranges.push(label.range(start, body), hide.range(close, end))
      atomic.push(label.range(start, body), hide.range(close, end))
      if (close > body) ranges.push(mark("cm-plan-note-text").range(body, close))
      const at = doc.lineAt(start)
      if (at.text.trim() === match[0]) {
        ranges.push(line("cm-plan-note-line").range(at.from))
        // A note indented into a list item lines up by style, not by its spaces.
        if (start > at.from) ranges.push(hide.range(at.from, start))
      }
    }
  }
  return { decorations: Decoration.set(ranges, true), atomic: Decoration.set(atomic, true) }
}

const notes = ViewPlugin.fromClass(
  class {
    rendered: Rendered
    constructor(view: EditorView) {
      this.rendered = decorate(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) this.rendered = decorate(update.view)
    }
  },
  { decorations: (plugin) => plugin.rendered.decorations },
)

const addNoteShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⌥M" : "Ctrl+Alt+M"

class AddNoteMarker extends GutterMarker {
  constructor(readonly heading: number) {
    super()
  }
  override eq(other: AddNoteMarker): boolean {
    return other.heading === this.heading
  }
  override toDOM(): Node {
    const button = document.createElement("span")
    button.className = "icon-button cm-plan-add-note"
    // Headings sit lower in their taller lines; the marker follows their text.
    if (this.heading) button.dataset.heading = String(this.heading)
    button.title = `Add a note (${addNoteShortcut})`
    button.setAttribute("aria-label", "Add a note")
    button.append(noteIcon())
    return button
  }
}
const addNoteMarkers = [0, 1, 2, 3].map((heading) => new AddNoteMarker(heading))
const addNoteMarker = addNoteMarkers[0]!

const noteGutter = gutter({
  class: "cm-plan-note-gutter",
  // Tables have a note button on every row instead.
  lineMarker: (view, block) =>
    block.widget
      ? null
      : addNoteMarkers[
          /^(#{1,3}) /.exec(view.state.doc.lineAt(block.from).text)?.[1]?.length ?? 0
        ]!,
  initialSpacer: () => addNoteMarker,
  domEventHandlers: {
    mousedown: (view, block) => {
      if (block.widget || view.state.readOnly) return false
      addNote(view, block.from)
      return true
    },
  },
})

// Backspace in an empty note removes the note, and its line when it had one to itself.
const removeEmptyNote = (view: EditorView): boolean => {
  const { head, empty } = view.state.selection.main
  if (!empty) return false
  const current = view.state.doc.lineAt(head)
  const start = current.text.indexOf(noteOpen + noteClose)
  if (start < 0 || head !== current.from + start + noteOpen.length) return false
  const alone = current.text.trim() === noteOpen + noteClose
  const from = alone ? Math.max(current.from - 1, 0) : current.from + start
  const to = alone ? current.to : current.from + start + noteOpen.length + noteClose.length
  view.dispatch({ changes: { from, to }, selection: EditorSelection.cursor(from) })
  return true
}

// A click in a note's line types in the note, not past its hidden wrapper.
const clickIntoNotes = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.selection || !transaction.isUserEvent("select.pointer")) return transaction
  const { head, empty } = transaction.selection.main
  const caret = empty ? caretInNote(transaction.newDoc, head) : head
  return caret === head
    ? transaction
    : [transaction, { selection: EditorSelection.cursor(caret), sequential: true }]
})

// Enter in a note finishes it and starts a line after it.
const finishNote = (view: EditorView): boolean => {
  const { head, empty } = view.state.selection.main
  const leave = empty ? leaveNote(view.state.doc, head) : null
  if (!leave) return false
  view.dispatch({
    changes: { from: leave.at, insert: "\n" },
    selection: EditorSelection.cursor(leave.at + 1),
    scrollIntoView: true,
  })
  return true
}

// Notes opened and left empty go once the caret leaves them or the editor loses focus.
const dropEmptyNotes = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate): void {
      if (!update.docChanged && !update.selectionSet && !update.focusChanged) return
      const { view } = update
      const caret = (): number | null =>
        update.focusChanged && !view.hasFocus ? null : view.state.selection.main.head
      if (!emptyNoteRemovals(view.state.doc, caret()).length) return
      // An update can't dispatch; do it right after, from the state then.
      queueMicrotask(() => {
        const removals = emptyNoteRemovals(view.state.doc, caret())
        if (removals.length) view.dispatch({ changes: removals })
      })
    }
  },
)

// Text typed or pasted into a note stays one line with no `-->` in it.
const safeNoteInput = [
  EditorView.inputHandler.of((view, from, to, text) => {
    const change = noteInput(view.state.doc, from, to, text)
    if (!change) return false
    view.dispatch({
      changes: { from: change.from, to: change.to, insert: change.insert },
      selection: EditorSelection.cursor(change.caret),
      userEvent: "input.type",
    })
    return true
  }),
  EditorView.clipboardInputFilter.of((text, state) =>
    inNoteText(state.doc, state.selection.main.head) ? noteSafe(text) : text,
  ),
  EditorState.transactionFilter.of((transaction) => {
    if (!transaction.docChanged || !transaction.isUserEvent("delete")) return transaction
    const fixes = notesReopened(transaction)
    return fixes.length ? [transaction, { changes: fixes, sequential: true }] : transaction
  }),
]

// The keyboard's way to the note button: a note under the caret's line.
const addNoteHere = (view: EditorView): boolean => {
  if (view.state.readOnly) return false
  addNote(view, view.state.doc.lineAt(view.state.selection.main.head).from)
  return true
}

// Lines' own padding. A note's wins over a list item's it may sit in.
const noteTheme = EditorView.theme({
  ".cm-line.cm-plan-note-line": { padding: "14px 12px 8px calc(var(--_note-indent) + 10px)" },
})

export const planNotes: Extension = [
  clickIntoNotes,
  safeNoteInput,
  dropEmptyNotes,
  notes,
  noteGutter,
  highlightActiveLineGutter(),
  EditorView.atomicRanges.of((view) => view.plugin(notes)?.rendered.atomic ?? Decoration.none),
  Prec.high(
    keymap.of([
      { key: "Backspace", run: removeEmptyNote },
      { key: "Enter", run: finishNote },
      { key: "Mod-Alt-m", run: addNoteHere },
    ]),
  ),
  noteTheme,
]

// A table row's note is the viewer's row annotation.
export const rowNotes: RowAnnotations = {
  open: noteOpen,
  close: noteClose,
  safe: noteSafe,
  mark: noteLabel,
  icon: () => noteIcon(),
  buttonClass: "icon-button",
  addLabels: { row: "Add a note on this row", table: "Add a note on the table" },
  fieldLabel: (row) => `Note on row ${row + 1}`,
  addBeside: addNote,
}
