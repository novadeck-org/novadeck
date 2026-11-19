import { lazyView } from "../lazy-view"
import type { MarkdownEditorProps } from "./editor/MarkdownEditor"

// The editor loads when a document first opens, so the workspace never pays for it.
const MarkdownEditor = lazyView<MarkdownEditorProps>(
  () => import("./editor/MarkdownEditor").then((module) => module.MarkdownEditor),
  null,
)

// A Markdown document, formatted where it's read, editable or read-only: nothing until its
// editor has loaded. A kind that adds to it, as a plan does its notes, loads its own module
// around `MarkdownEditor` instead, so what it adds loads with the editor.
export const MarkdownDocument = (props: MarkdownEditorProps): React.JSX.Element => (
  <MarkdownEditor {...props} />
)
