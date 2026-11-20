import { bytesText } from "@novadeck/core/command-text"
import type { PdfContent } from "@novadeck/core/items"
import { FileType } from "lucide-react"

// A PDF's badge and size, for its peek: its bytes are never read for it.
export const PdfThumb = ({ content }: { content: PdfContent }): React.JSX.Element => (
  <span className="peek-pdf">
    <FileType size={18} strokeWidth={1.5} aria-hidden />
    <span>PDF</span>
    <span>{bytesText(content.size)}</span>
  </span>
)
