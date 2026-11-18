import { Folder } from "lucide-react"

import { artifactLook, artifactThumb } from "../../ArtifactViewer"
import type { ItemRegistration } from "../../registration"
import { FolderThumb } from "./FolderThumb"
import { FolderView } from "./FolderView"

// A folder an agent showed or the person opened, listed read-only as a grid or a list, with its
// files opening as items of their own kinds.
export const folder = {
  kind: "folder",
  names: { one: "folder", many: "Folders" },
  icon: () => Folder,
  stackIcon: Folder,
  look: artifactLook,
  Thumb: artifactThumb("folder", FolderThumb),
  View: FolderView,
} satisfies ItemRegistration<"folder">
