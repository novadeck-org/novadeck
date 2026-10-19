import { Globe } from "lucide-react"

import { artifactLook, artifactThumb, artifactView } from "../../ArtifactViewer"
import type { ItemMember } from "../../bar"
import type { PaneRegistration } from "../../registration"
import { PageThumb, PageViewer } from "./PageViewer"

// A page an agent showed, shown with the browser viewer.
export const page = {
  kind: "page",
  names: { one: "page", many: "Pages" },
  icon: () => Globe,
  stackIcon: Globe,
  look: artifactLook,
  Thumb: artifactThumb("page", PageThumb),
  View: artifactView("page", PageViewer),
} satisfies PaneRegistration<ItemMember, "page">
