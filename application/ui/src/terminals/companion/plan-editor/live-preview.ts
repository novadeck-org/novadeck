import { syntaxTree } from "@codemirror/language"
import {
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Range,
} from "@codemirror/state"
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

import { notePattern } from "../../../model/companion"
import type { Mark } from "../plan-doc"
import {
  addNote,
  caretInNote,
  emptyNoteRemovals,
  inNoteText,
  leaveNote,
  noteClose,
  noteIcon,
  noteInput,
  noteSafe,
  noteLabel as noteMark,
  noteOpen,
  notesReopened,
} from "./notes"
import { tables } from "./table-widget"

// Markdown shown as a document and edited in place. Formatting marks show, dimmed, only on
// the lines being edited, where the text reads exactly as the file has it and typing
// Markdown is how the plan gets formatted. Note wrappers never show: they're NovaDeck's
// own, not formatting. Nothing here changes the text on its own.

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked
  }
  override toDOM(): HTMLElement {
    const box = document.createElement("span")
    box.className = "cm-plan-checkbox"
    box.dataset.checked = String(this.checked)
    box.setAttribute("aria-hidden", "true")
    if (this.checked) {
      // A real tick, drawn like the plan's other icons.
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
      for (const [name, value] of Object.entries({
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "3.5",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }))
        svg.setAttribute(name, value)
      const tick = document.createElementNS("http://www.w3.org/2000/svg", "path")
      tick.setAttribute("d", "M20 6 9 17l-5-5")
      svg.append(tick)
      box.append(svg)
    }
    return box
  }
  // Clicks reach the plugin, which flips the marker in the text.
  override ignoreEvent(): boolean {
    return false
  }
}

class NoteLabel extends WidgetType {
  override eq(): boolean {
    return true
  }
  override toDOM(): HTMLElement {
    return noteMark()
  }
}

const hide = Decoration.replace({})
const noteLabel = Decoration.replace({ widget: new NoteLabel() })
const line = (className: string) => Decoration.line({ class: className })
const mark = (className: string) => Decoration.mark({ class: className })

// The lines the cursor or selection is on, where syntax shows as written.
const activeLines = (view: EditorView): Set<number> => {
  const lines = new Set<number>()
  for (const range of view.state.selection.ranges) {
    const first = view.state.doc.lineAt(range.from).number
    const last = view.state.doc.lineAt(range.to).number
    for (let number = first; number <= last; number++) lines.add(number)
  }
  return lines
}

type Rendered = { decorations: DecorationSet; atomic: DecorationSet }

const decorate = (view: EditorView): Rendered => {
  const { doc } = view.state
  const active = activeLines(view)
  const editing = (from: number): boolean => view.hasFocus && active.has(doc.lineAt(from).number)
  const ranges: Range<Decoration>[] = []
  // Ranges the cursor steps over whole, and Backspace removes whole.
  const atomic: Range<Decoration>[] = []
  const eachLine = (from: number, to: number, decoration: Decoration): void => {
    for (let at = doc.lineAt(from); ; at = doc.line(at.number + 1)) {
      ranges.push(decoration.range(at.from))
      if (at.to >= to || at.number === doc.lines) break
    }
  }
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const { name } = node
        const heading = /^ATXHeading(\d)$/.exec(name)
        if (heading) ranges.push(line(`cm-plan-h${heading[1]}`).range(doc.lineAt(node.from).from))
        else if (name === "HeaderMark") {
          // Shown only on the line being edited, where changing them changes the heading.
          // They hang left of the heading, so its text stays put. Elsewhere they're hidden
          // with the space after them, and the cursor steps over them whole.
          const end = Math.min(node.to + 1, doc.lineAt(node.from).to)
          if (editing(node.from))
            ranges.push(mark("cm-plan-syntax cm-plan-hashes").range(node.from, end))
          else {
            ranges.push(hide.range(node.from, end))
            atomic.push(hide.range(node.from, end))
          }
        } else if (name === "Blockquote") eachLine(node.from, node.to, line("cm-plan-quote"))
        else if (name === "FencedCode") {
          eachLine(node.from, node.to, line("cm-plan-codeblock"))
          if (!editing(node.from))
            ranges.push(line("cm-plan-fence").range(doc.lineAt(node.from).from))
          if (!editing(node.to)) ranges.push(line("cm-plan-fence").range(doc.lineAt(node.to).from))
          return false
        } else if (name === "Table") return false
        else if (name === "StrongEmphasis")
          ranges.push(mark("cm-plan-strong").range(node.from, node.to))
        else if (name === "Emphasis") ranges.push(mark("cm-plan-em").range(node.from, node.to))
        else if (name === "InlineCode") {
          const code = doc.sliceString(node.from, node.to)
          ranges.push(
            mark(/[/.]\w/.test(code) ? "cm-plan-code cm-plan-path" : "cm-plan-code").range(
              node.from,
              node.to,
            ),
          )
        } else if (name === "ListItem") {
          // Wrapped item text hangs under the item's text, not its marker.
          const task = /^\s*(?:\d+[.)]|[-*+])\s+\[[ xX]\]/.test(doc.lineAt(node.from).text)
          eachLine(
            node.from,
            node.to,
            line(task ? "cm-plan-item cm-plan-item-task" : "cm-plan-item"),
          )
        } else if (name === "ListMark")
          ranges.push(mark("cm-plan-listmark").range(node.from, node.to))
        else if (name === "TaskMarker") {
          const done = /x/i.test(doc.sliceString(node.from, node.to))
          // A done task recedes, so what's left stands out.
          if (done) eachLine(node.from, node.node.parent?.to ?? node.to, line("cm-plan-task-done"))
          ranges.push(
            editing(node.from)
              ? mark("cm-plan-syntax").range(node.from, node.to)
              : Decoration.replace({
                  widget: new CheckboxWidget(done),
                }).range(node.from, node.to),
          )
        } else if (
          (name === "QuoteMark" || name === "EmphasisMark" || name === "CodeMark") &&
          node.node.parent?.name !== "FencedCode"
        ) {
          // Formatting marks: dimmed on the line being edited, where typing them formats
          // the plan, and hidden elsewhere, taking a quote mark's space with it.
          const end =
            name === "QuoteMark" ? Math.min(node.to + 1, doc.lineAt(node.from).to) : node.to
          ranges.push(
            editing(node.from)
              ? mark("cm-plan-syntax").range(node.from, node.to)
              : hide.range(node.from, end),
          )
        }
        return undefined
      },
    })
    // Notes are NovaDeck's own convention, not Markdown, so they're found in the text. Their
    // wrapper never shows: a note reads and edits the same, as a labelled line.
    const text = doc.sliceString(from, to)
    for (const match of text.matchAll(notePattern)) {
      const start = from + match.index
      const end = start + match[0].length
      const body = start + noteOpen.length
      const close = end - noteClose.length
      ranges.push(noteLabel.range(start, body), hide.range(close, end))
      atomic.push(noteLabel.range(start, body), hide.range(close, end))
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

const preview = ViewPlugin.fromClass(
  class {
    rendered: Rendered
    constructor(view: EditorView) {
      this.rendered = decorate(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged)
        this.rendered = decorate(update.view)
    }
  },
  {
    decorations: (plugin) => plugin.rendered.decorations,
    eventHandlers: {
      // A checkbox flips its marker in the text, as typing would.
      mousedown: (event, view) => {
        const target = event.target as HTMLElement
        if (!target.classList.contains("cm-plan-checkbox")) return false
        const at = view.posAtDOM(target)
        const marker = view.state.doc.sliceString(at, at + 3)
        if (!/^\[[ xX]\]$/.test(marker)) return false
        view.dispatch({
          changes: { from: at + 1, to: at + 2, insert: marker[1] === " " ? "x" : " " },
        })
        return true
      },
    },
  },
)

// What the agent's latest revision wrote, highlighted until the user reads past it.
export const setMarks = StateEffect.define<readonly Mark[]>()

const markedLines = (state: EditorView["state"], marks: readonly Mark[]): DecorationSet => {
  const lines = new Set<number>()
  for (const { from, to } of marks) {
    const first = state.doc.lineAt(Math.min(from, state.doc.length)).number
    const last = state.doc.lineAt(Math.min(Math.max(to - 1, from), state.doc.length)).number
    for (let number = first; number <= last; number++) lines.add(number)
  }
  return Decoration.set(
    [...lines]
      .toSorted((a, b) => a - b)
      .map((number) => line("cm-plan-changed").range(state.doc.line(number).from)),
  )
}

const agentMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (marks, transaction) => {
    for (const effect of transaction.effects)
      if (effect.is(setMarks)) return markedLines(transaction.state, effect.value)
    return marks.map(transaction.changes)
  },
  provide: (field) => EditorView.decorations.from(field),
})

const addNoteShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⌥M" : "Ctrl+Alt+M"

// The highlighted lines as they stand, moved along with the user's edits.
export const currentAgentMarks = (state: EditorState): Mark[] => {
  const marks: Mark[] = []
  const iterator = state.field(agentMarks).iter()
  for (; iterator.value; iterator.next()) {
    const { from, to } = state.doc.lineAt(iterator.from)
    marks.push({ from, to })
  }
  return marks
}

class AddNoteMarker extends GutterMarker {
  constructor(readonly heading: number) {
    super()
  }
  override eq(other: AddNoteMarker): boolean {
    return other.heading === this.heading
  }
  override toDOM(): Node {
    const button = document.createElement("span")
    button.className = "cm-plan-add-note"
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

export const livePreview = [
  clickIntoNotes,
  safeNoteInput,
  dropEmptyNotes,
  preview,
  tables,
  agentMarks,
  noteGutter,
  highlightActiveLineGutter(),
  EditorView.atomicRanges.of((view) => view.plugin(preview)?.rendered.atomic ?? Decoration.none),
  Prec.high(
    keymap.of([
      { key: "Backspace", run: removeEmptyNote },
      { key: "Enter", run: finishNote },
      { key: "Mod-Alt-m", run: addNoteHere },
    ]),
  ),
]
