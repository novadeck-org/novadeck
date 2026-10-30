import { BookText, FileCode2 } from "lucide-react"

import { artifactLook, artifactThumb, artifactView } from "../../ArtifactViewer"
import type { ItemRegistration } from "../../registration"
import { FileThumb, FileViewer } from "./FileViewer"
import { isMarkdown } from "./markdown"

// A text file an agent showed: as code, or a Markdown file as a document. A stack of files
// takes the code's icon whatever they are.
export const file = {
  kind: "file",
  names: { one: "file", many: "Files" },
  icon: (item: { readonly name: string }) => (isMarkdown(item.name) ? BookText : FileCode2),
  stackIcon: FileCode2,
  look: artifactLook,
  Thumb: artifactThumb("file", FileThumb),
  View: artifactView("file", FileViewer, (content) => isMarkdown(content.path)),
} satisfies ItemRegistration<"file">
