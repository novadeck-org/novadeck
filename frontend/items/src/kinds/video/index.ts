import { Film } from "lucide-react"

import { artifactLook, artifactThumb, artifactView } from "../../ArtifactViewer"
import type { ItemRegistration } from "../../registration"
import { VideoThumb, VideoViewer } from "./VideoViewer"

// A video an agent showed, played with the pane's own bar.
export const video = {
  kind: "video",
  names: { one: "video", many: "Videos" },
  icon: () => Film,
  stackIcon: Film,
  look: artifactLook,
  Thumb: artifactThumb("video", VideoThumb),
  View: artifactView("video", VideoViewer),
} satisfies ItemRegistration<"video">
