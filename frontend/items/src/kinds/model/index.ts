import { Box } from "lucide-react"

import { artifactLook, artifactThumb, artifactView } from "../../ArtifactViewer"
import type { ItemRegistration } from "../../registration"
import { ModelThumb } from "./ModelThumb"
import { ModelViewer } from "./ModelViewer"

// A 3D model an agent showed (glTF, STL, OBJ, PLY or 3MF), drawn in the round with the 3D viewer.
export const model = {
  kind: "model",
  names: { one: "3D model", many: "3D models" },
  icon: () => Box,
  stackIcon: Box,
  look: artifactLook,
  Thumb: artifactThumb("model", ModelThumb),
  View: artifactView("model", ModelViewer),
} satisfies ItemRegistration<"model">
