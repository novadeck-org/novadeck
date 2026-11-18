import { FileType } from "lucide-react"

import { artifactLook, artifactThumb, artifactView } from "../../ArtifactViewer"
import type { ItemRegistration } from "../../registration"
import { PdfThumb, PdfViewer } from "./PdfViewer"

// A PDF an agent showed, drawn page by page with the PDF viewer.
export const pdf = {
  kind: "pdf",
  names: { one: "PDF", many: "PDFs" },
  icon: () => FileType,
  stackIcon: FileType,
  look: artifactLook,
  Thumb: artifactThumb("pdf", PdfThumb),
  View: artifactView("pdf", PdfViewer),
} satisfies ItemRegistration<"pdf">
