import { BookText } from "lucide-react"

import type { FilePreview } from "."
import { OutlineThumb } from "../../../document/OutlineThumb"
import { DocumentViewer } from "../DocumentViewer"
import { isMarkdown } from "../markdown"

// A Markdown file reads as a document, formatted, with its outline; in miniature, its title
// over its sections.
export const markdown: FilePreview = {
  name: "markdown",
  matches: isMarkdown,
  icon: BookText,
  View: DocumentViewer,
  Thumb: ({ content }) => <OutlineThumb path={content.path} text={content.lines.join("\n")} />,
}
