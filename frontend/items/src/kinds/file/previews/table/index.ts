import { Sheet } from "lucide-react"

import type { FilePreview } from ".."
import { TableThumb, TableView } from "./TableView"

// A CSV or TSV file reads as a table.
export const table: FilePreview = {
  name: "table",
  matches: (path) => /\.(csv|tsv)$/i.test(path),
  icon: Sheet,
  View: TableView,
  Thumb: TableThumb,
}
