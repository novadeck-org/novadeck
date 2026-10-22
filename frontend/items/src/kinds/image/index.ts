import { Image } from "lucide-react"

import { artifactLook, artifactThumb, artifactView } from "../../ArtifactViewer"
import type { ItemRegistration } from "../../registration"
import { ImageThumb, ImageViewer } from "./ImageViewer"

// An image an agent showed, shown with the image viewer.
export const image = {
  kind: "image",
  names: { one: "image", many: "Images" },
  icon: () => Image,
  stackIcon: Image,
  look: artifactLook,
  Thumb: artifactThumb("image", ImageThumb),
  View: artifactView("image", ImageViewer),
} satisfies ItemRegistration<"image">
