import { Facet } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"

// What an app writes into a table's rows beyond Markdown: a short text at the end of a
// row's last cell, between a pair of markers the app picks, such as an HTML comment. The
// viewer keeps it out of the row's cells, shows it under its row, and edits it in place;
// what it means is the app's.
export type RowAnnotations = {
  /** The text an annotation opens with, and the text it closes with, as written. */
  readonly open: string
  readonly close: string
  /** An annotation's text made fit between them: nothing that would close it early. */
  readonly safe: (text: string) => string
  /** The small mark an annotation starts with. */
  readonly mark: () => HTMLElement
  /** The icon of the control that adds one. */
  readonly icon: () => Element
  /** The class the control that adds one also takes, for the app's button looks. */
  readonly buttonClass?: string
  /** What the control that adds one is called, on a row and on the whole table. */
  readonly addLabels: { readonly row: string; readonly table: string }
  /** What an annotation's text field is called, by its row (the header is row 0). */
  readonly fieldLabel: (row: number) => string
  /** Adds one beside the table, which the whole table's goes after: the header's control. */
  readonly addBeside: (view: EditorView, at: number) => void
}

export const rowAnnotations = Facet.define<RowAnnotations, RowAnnotations | null>({
  combine: (values) => values[0] ?? null,
})
