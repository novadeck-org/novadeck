import type { FileContent, ItemId } from "@novadeck/core/items"
import type { LucideIcon } from "lucide-react"
import type { ComponentType } from "react"

import { markdown } from "./markdown"

// The file types that read as something other than their source: a Markdown file as a
// document, and so on. A file of one shows its preview first, and the pane's row gets a
// switch between it and its source, the bare file in the code viewer. A file of no type here
// shows as code, with no switch. A type joins with a folder or module of its own here and one
// line in `previews` below.

// What a preview is given: the file, and the item showing it, which keeps where its viewer was.
export type PreviewProps = {
  readonly id: ItemId
  // The item's name, as the file reads to assistive technology.
  readonly name: string
  readonly content: FileContent
}

export type FilePreview = {
  // Names the preview to the stylesheet and tests: the file's `data-preview`.
  readonly name: string
  // Whether a file, by its path, is of this type.
  readonly matches: (path: string) => boolean
  // The file on its bar and tab, in place of a source file's.
  readonly icon: LucideIcon
  // The preview, in the pane, under the row.
  readonly View: ComponentType<PreviewProps>
  // Its peek miniature; a source file's (the lines the agent pointed at) where it has none.
  readonly Thumb?: ComponentType<{ readonly content: FileContent }>
}

// First match wins.
export const previews: readonly FilePreview[] = [markdown]

// The preview of the file at `path`, if its type has one.
export const previewFor = (path: string): FilePreview | undefined =>
  previews.find((preview) => preview.matches(path))
