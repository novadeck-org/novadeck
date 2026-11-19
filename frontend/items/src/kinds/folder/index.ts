import { Folder } from "lucide-react"
import { createElement } from "react"

import { artifactLook, artifactThumb } from "../../ArtifactViewer"
import { lazyView } from "../../lazy-view"
import type { ItemRegistration, ViewProps } from "../../registration"
import { FolderThumb } from "./FolderThumb"

// The view, its grid and list, and how it draws its files' pictures load when a folder first
// shows, so the workspace never pays for them.
const FolderView = lazyView<ViewProps>(
  () => import("./FolderView").then((module) => module.FolderView),
  createElement("div", { className: "artifact-status" }),
)

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
