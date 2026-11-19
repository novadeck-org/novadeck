import { FileType } from "lucide-react"

import { artifactLook, artifactThumb, artifactView } from "../../ArtifactViewer"
import { lazyView } from "../../lazy-view"
import type { ItemRegistration } from "../../registration"
import { PdfThumb } from "./PdfThumb"

// The viewer, with pdf.js's frame and its own code, loads when a PDF first shows.
const PdfViewer = lazyView(
  () => import("./PdfViewer").then((module) => module.PdfViewer),
  <div className="pdf-pane" aria-busy />,
)

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
