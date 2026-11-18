import { FileCode2 } from "lucide-react"

import { artifactLook, artifactThumb, artifactView } from "../../ArtifactViewer"
import type { ItemRegistration } from "../../registration"
import { FileThumb, FileViewer } from "./FileViewer"
import { previewFor } from "./previews"

// A text file an agent showed: as code, or, for a type with a preview (./previews), as that,
// with a switch to its source. A stack of files takes the code's icon whatever they are.
export const file = {
  kind: "file",
  names: { one: "file", many: "Files" },
  icon: (item: { readonly name: string }) => previewFor(item.name)?.icon ?? FileCode2,
  stackIcon: FileCode2,
  look: artifactLook,
  Thumb: artifactThumb("file", FileThumb),
  View: artifactView("file", FileViewer),
} satisfies ItemRegistration<"file">
