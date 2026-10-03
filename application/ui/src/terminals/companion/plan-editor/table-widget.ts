import { StateField, type ChangeSpec, type EditorState } from "@codemirror/state"
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view"

import { addNote, noteIcon, noteLabel } from "./notes"
import {
  addColumn,
  addRow,
  addRowNote,
  cellSource,
  findTables,
  removeColumn,
  removeRow,
  setRowNote,
  type Change,
  type Table,
} from "./tables"

// Tables always read as tables. A cell edits in place, and leaving it writes just that
// cell's text into the file. While a cell is being edited, a toolbar adds and removes
// rows and columns. Each row takes a note, kept inside the row; the header's note is on
// the whole table and goes after it.

type Place = { readonly row: number; readonly column: number }

// What to focus once an edit has re-rendered its table: a cell, or a row's note.
let pending: Place | { readonly row: number; readonly note: true } | null = null

const texts = (table: Table): string =>
  JSON.stringify([
    table.rows.map((row) => row.map((cell) => cell.text)),
    table.notes.map((note) => note?.text),
  ])

const columnsOf = (table: Table): number => Math.max(...table.rows.map((row) => row.length))

const placeCaret = (cell: HTMLTextAreaElement): void => {
  cell.focus()
  cell.setSelectionRange(cell.value.length, cell.value.length)
}

// The table starting at `at`, read afresh from the text.
const tableAt = (view: EditorView, at: number): Table | undefined =>
  findTables(view.state.doc.toString()).find((found) => found.from === at)

// Writes a cell's text into the file. The table's start doesn't move when one of its
// cells changes, so it finds the table again from there.
const commit = (view: EditorView, at: number, place: Place, text: string): boolean => {
  const cell = tableAt(view, at)?.rows[place.row]?.[place.column]
  if (!cell) return false
  const insert = cellSource(text)
  if (insert === view.state.doc.sliceString(cell.from, cell.to)) return false
  view.dispatch({ changes: { from: cell.from, to: cell.to, insert } })
  return true
}

// A change to a table's shape, and the cell to edit once it's made, both worked out
// from the table as it is.
type Reshape = (
  table: Table,
  place: Place,
) => { changes: Change | readonly Change[] | null; focus: Place }

const addRowBelow: Reshape = (table, place) => ({
  changes: addRow(table, place.row),
  focus: { row: place.row + 1, column: place.column },
})

const addColumnRight: Reshape = (table, place) => ({
  changes: addColumn(table, place.column),
  focus: { row: place.row, column: place.column + 1 },
})

const deleteRow: Reshape = (table, place) => ({
  changes: removeRow(table, place.row),
  focus: { row: Math.min(place.row, table.rows.length - 2), column: place.column },
})

const deleteColumn: Reshape = (table, place) => ({
  changes: removeColumn(table, place.column),
  focus: { row: place.row, column: Math.min(place.column, columnsOf(table) - 2) },
})

const tool = (label: string, title: string): HTMLButtonElement => {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "cm-plan-table-tool"
  button.textContent = label
  button.title = title
  return button
}

class TableWidget extends WidgetType {
  constructor(readonly table: Table) {
    super()
  }
  // Text edits elsewhere shift a table without changing it, so its DOM, and any cell
  // being edited, stays.
  override eq(other: TableWidget): boolean {
    return texts(other.table) === texts(this.table)
  }
  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div")
    wrapper.className = "cm-plan-table-widget"
    if (view.state.readOnly) wrapper.dataset.readonly = "true"
    const table = document.createElement("table")
    const width = columnsOf(this.table)
    const height = this.table.rows.length
    const cells: HTMLTextAreaElement[][] = []
    const at = (): number => view.posAtDOM(wrapper)
    // Where the table is, unless the editor already let go of it: an agent rewriting the
    // table blurs the field being edited while its widget is being removed.
    const placed = (): number | null => {
      try {
        return view.posAtDOM(wrapper)
      } catch {
        return null
      }
    }
    // The cell being edited, and how to hand it over before the table changes.
    let active: { place: Place; text: () => string; leave: () => void } | null = null
    const notes: HTMLTextAreaElement[] = []

    // Writes the cell being edited, before a note changes the table under it.
    const flush = (start: number): boolean => {
      if (!active) return false
      active.leave()
      return commit(view, start, active.place, active.text())
    }

    // Reshapes the table; a change the editor refused, as in a read-only plan, leaves
    // no focus waiting for a table that isn't coming.
    const dispatchReshape = (changes: ChangeSpec): void => {
      const before = view.state.doc
      view.dispatch({ changes })
      if (view.state.doc === before) pending = null
    }

    // Opens a row's note, adding it if it has none. The header's note is on the whole
    // table, and goes after it.
    const noteOn = (row: number): void => {
      const start = at()
      pending = { row, note: true }
      const committed = flush(start)
      if (!committed) pending = null
      if (row === 0) {
        pending = null
        addNote(view, start)
        return
      }
      const current = tableAt(view, start)
      if (!current) return
      if (current.notes[row]) {
        if (!committed) {
          const input = notes[row]
          if (input) placeCaret(input)
        }
        return
      }
      const added = addRowNote(current, row)
      if (!added) return
      pending = { row, note: true }
      dispatchReshape(added.change)
    }

    const rowNoteButton = (row: number): HTMLButtonElement => {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "icon-button cm-plan-row-note-add"
      const label = row === 0 ? "Add a note on the table" : "Add a note on this row"
      button.title = label
      button.setAttribute("aria-label", label)
      button.append(noteIcon())
      // Act on press, keeping the press from the workspace, as the toolbar does.
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault()
        event.stopPropagation()
        noteOn(row)
      })
      button.addEventListener("mousedown", (event) => event.preventDefault())
      button.addEventListener("click", (event) => {
        if (event.detail === 0) noteOn(row)
      })
      return button
    }

    // A row's note, under the row, edited in place. Emptying it removes it.
    const noteRow = (row: number, text: string): HTMLTableRowElement => {
      const line = document.createElement("tr")
      line.className = "cm-plan-row-note"
      const box = document.createElement("td")
      box.colSpan = width
      const label = noteLabel()
      const input = document.createElement("textarea")
      input.className = "cm-plan-row-note-input"
      input.readOnly = view.state.readOnly
      input.rows = 1
      input.spellcheck = false
      input.value = text
      input.setAttribute("aria-label", `Note on row ${row + 1}`)
      let left = false
      const save = (): void => {
        left = true
        const current = tableAt(view, at())
        const change = current && setRowNote(current, row, input.value)
        if (!change) return
        if (change.insert === view.state.doc.sliceString(change.from, change.to)) return
        view.dispatch({ changes: change })
      }
      input.addEventListener("keydown", (event) => {
        event.stopPropagation()
        if (event.key === "Enter") {
          event.preventDefault()
          save()
          view.focus()
        } else if (event.key === "Escape") {
          event.preventDefault()
          // A note never written is dropped; one already there keeps its text.
          input.value = text
          save()
          view.focus()
        } else if (event.key === "Backspace" && !input.value) {
          event.preventDefault()
          save()
          view.focus()
        }
      })
      input.addEventListener("blur", () => {
        if (left) {
          left = false
          return
        }
        // The table was rewritten under the note, which went with it.
        if (placed() === null) return
        save()
      })
      notes[row] = input
      // A bubble sized to its text, as notes elsewhere in the plan are.
      const bubble = document.createElement("span")
      bubble.className = "cm-plan-row-note-bubble"
      bubble.append(label, input)
      box.append(bubble)
      line.append(box)
      return line
    }

    // Writes the active cell, then changes the table's shape and edits the given cell.
    const act = (reshape: Reshape): void => {
      if (!active) return
      const { place, text, leave } = active
      const start = at()
      leave()
      commit(view, start, place, text())
      const current = tableAt(view, start)
      if (!current) return
      const { changes, focus } = reshape(current, place)
      if (!changes || (Array.isArray(changes) && !changes.length)) return
      pending = focus
      dispatchReshape(changes)
    }

    const toolbar = document.createElement("div")
    toolbar.className = "cm-plan-table-tools"
    const buttons = {
      addRow: tool("+ Row", "Add a row below"),
      addColumn: tool("+ Column", "Add a column to the right"),
      deleteRow: tool("Delete row", "Delete this row"),
      deleteColumn: tool("Delete column", "Delete this column"),
    }
    const reshapes: [HTMLButtonElement, Reshape][] = [
      [buttons.addRow, addRowBelow],
      [buttons.addColumn, addColumnRight],
      [buttons.deleteRow, deleteRow],
      [buttons.deleteColumn, deleteColumn],
    ]
    for (const [button, reshape] of reshapes) {
      // Act on press, while the cell still has focus, and keep the press to the toolbar:
      // the workspace behind moves focus on press, which would blur the cell and
      // re-render the table before a click arrives.
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!button.disabled) act(reshape)
      })
      button.addEventListener("mousedown", (event) => event.preventDefault())
      // Keyboard activation has no press.
      button.addEventListener("click", (event) => {
        if (event.detail === 0) act(reshape)
      })
      toolbar.append(button)
    }

    this.table.rows.forEach((row, rowIndex) => {
      const line = document.createElement("tr")
      cells.push([])
      for (let column = 0; column < width; column++) {
        const place = { row: rowIndex, column }
        const box = document.createElement(rowIndex === 0 ? "th" : "td")
        // A text area, not editable markup: typing changes its value, not the DOM the
        // editor watches, so the editor never mistakes it for an edit of its own.
        const cell = document.createElement("textarea")
        // A plan the backend can't write reads, but takes no edits.
        cell.readOnly = view.state.readOnly
        cell.className = "cm-plan-cell"
        cell.rows = 1
        cell.spellcheck = false
        cell.value = row[column]?.text ?? ""
        cell.setAttribute("aria-label", `Row ${rowIndex + 1}, column ${column + 1}`)
        const original = cell.value
        // Set once the cell has been written on the way out, so its blur doesn't write it
        // again.
        let left = false
        const leave = (): void => {
          left = true
        }
        // Leaves the cell for another, or for the plan when there's no cell to go to.
        const move = (to: Place | null): void => {
          leave()
          // Committing re-renders the table at once, so say where focus goes first.
          pending = to
          const changed = commit(view, at(), place, cell.value)
          if (changed && to) return
          pending = null
          const target = to && cells[to.row]?.[to.column]
          if (target) placeCaret(target)
          else view.focus()
        }
        cell.addEventListener("focus", () => {
          left = false
          active = { place, text: () => cell.value, leave }
          buttons.deleteRow.disabled = rowIndex === 0
          buttons.deleteColumn.disabled = width < 2
        })
        cell.addEventListener("keydown", (event) => {
          // A cell is its own small editor: keys never reach the plan's.
          event.stopPropagation()
          const lastColumn = column === width - 1
          if (event.key === "Tab") {
            event.preventDefault()
            // Tab past the last cell starts a new row, as in a spreadsheet.
            if (!event.shiftKey && lastColumn && rowIndex === height - 1) {
              act((current, from) => ({
                changes: addRow(current, from.row),
                focus: { row: from.row + 1, column: 0 },
              }))
              return
            }
            const next = !event.shiftKey
              ? lastColumn
                ? { row: rowIndex + 1, column: 0 }
                : { row: rowIndex, column: column + 1 }
              : column === 0
                ? { row: rowIndex - 1, column: width - 1 }
                : { row: rowIndex, column: column - 1 }
            move(next.row >= 0 && next.row < height ? next : null)
          } else if (event.key === "Enter") {
            event.preventDefault()
            move(rowIndex + 1 < height ? { row: rowIndex + 1, column } : null)
          } else if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            cell.value = original
            cell.blur()
          }
        })
        cell.addEventListener("blur", () => {
          if (left) {
            left = false
            return
          }
          // The agent rewrote the table under the cell: its place is gone, and so is what
          // was typed in it.
          const start = placed()
          if (start !== null && cell.value !== original) commit(view, start, place, cell.value)
        })
        cells[rowIndex]!.push(cell)
        box.append(cell)
        if (column === 0) box.append(rowNoteButton(rowIndex))
        line.append(box)
      }
      table.append(line)
      const note = this.table.notes[rowIndex]
      if (note) table.append(noteRow(rowIndex, note.text))
    })
    wrapper.append(toolbar, table)
    const focus = pending
    pending = null
    if (focus)
      queueMicrotask(() => {
        const target = "note" in focus ? notes[focus.row] : cells[focus.row]?.[focus.column]
        if (target) placeCaret(target)
      })
    return wrapper
  }
  // Cells and tools handle their own typing and clicks.
  override ignoreEvent(): boolean {
    return true
  }
}

const build = (state: EditorState): DecorationSet =>
  Decoration.set(
    findTables(state.doc.toString()).map((table) =>
      Decoration.replace({ widget: new TableWidget(table), block: true }).range(
        table.from,
        table.to,
      ),
    ),
  )

export const tables = StateField.define<DecorationSet>({
  create: build,
  update: (decorations, transaction) =>
    transaction.docChanged ? build(transaction.state) : decorations,
  provide: (field) => EditorView.decorations.from(field),
})
