import { GitCompare } from "lucide-react"

import { artifactLook, artifactThumb, artifactView } from "../../ArtifactViewer"
import type { ItemMember } from "../../bar"
import type { PaneRegistration } from "../../registration"
import { ChangesThumb, ChangesViewer } from "./ChangesViewer"

// An agent's whole change, its working tree against HEAD file by file, shown with the diff
// viewer.
export const changes = {
  kind: "changes",
  names: { one: "change", many: "Changes" },
  icon: () => GitCompare,
  stackIcon: GitCompare,
  look: artifactLook,
  Thumb: artifactThumb("changes", ChangesThumb),
  View: artifactView("changes", ChangesViewer),
} satisfies PaneRegistration<ItemMember, "changes">
