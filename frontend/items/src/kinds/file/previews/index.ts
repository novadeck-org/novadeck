import type { FileContent, ItemId } from "@novadeck/core/items"
import type { LucideIcon } from "lucide-react"
import type { ComponentType } from "react"

import { data } from "./data"
import { html } from "./html"
import { markdown } from "./markdown"
import { table } from "./table"

// The file types that read as something other than their source: a Markdown file as a
// document, and so on. A file of one shows its preview first, and the pane's row gets a
// switch between it and its source, the bare file in the code viewer. A file of no type here
// shows as code, with no switch. A type joins with a folder or module of its own here and one
// line in `previews` below. A preview that can't read its file (as JSON that doesn't parse)
// says so in its body: the switch to the source stays in the row. Its own tools go in the row
// beside the switch through `usePreviewTools` (./tools.ts).

// What a preview is given: the file, and the item showing it, which keeps where its viewer was.
export type PreviewProps = {
  readonly id: ItemId
  // The item's name, as the file reads to assistive technology.
  readonly name: string
  readonly content: FileContent
  // Shows the file's source instead, as when it doesn't read as its type, with a note why
  // above it and the line it stops at pointed at.
  readonly toSource: ToSource
  // Reads a file beside the one shown, whole, by its name from its folder (a page's stylesheet
  // or picture): undefined where it can't be read, or once the signal stops it. Absent where the
  // backend can't.
  readonly beside?: ReadBeside | undefined
}

export type ReadBeside = (
  name: string,
  signal: AbortSignal,
) => Promise<Uint8Array<ArrayBuffer> | undefined>

export type ToSource = (why?: { readonly note: string; readonly line?: number }) => void

export type FilePreview = {
  // Names the preview to the stylesheet and tests: the file's `data-file-preview`.
  readonly name: string
  // Whether a file is of this type, by its name or its path: the bar's icon asks by the item's
  // name, the pane by the shown file's path, so it matches by how the name ends.
  readonly matches: (path: string) => boolean
  // The file on its bar and tab, in place of a source file's.
  readonly icon: LucideIcon
  // The preview, in the pane, under the row.
  readonly View: ComponentType<PreviewProps>
  // Its peek miniature; a source file's (the lines the agent pointed at) where it has none.
  readonly Thumb?: ComponentType<{ readonly content: FileContent }>
}

// First match wins.
export const previews: readonly FilePreview[] = [markdown, table, data, html]

// The preview of the file at `path`, if its type has one.
export const previewFor = (path: string): FilePreview | undefined =>
  previews.find((preview) => preview.matches(path))

export { usePreviewTools } from "./tools"
