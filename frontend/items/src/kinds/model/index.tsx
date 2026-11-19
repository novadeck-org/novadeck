import { Box } from "lucide-react"

import { artifactLook, artifactThumb, artifactView } from "../../ArtifactViewer"
import type { ItemRegistration } from "../../registration"
import { lazyBody } from "../lazy"

// The 3D viewer and the peek's stills and badge load when a model first shows; till then a
// peek holds its badge's place.
const ModelViewer = lazyBody(
  () => import("./ModelViewer").then((module) => module.ModelViewer),
  <div className="model-pane" aria-busy />,
)
const ModelThumb = lazyBody(
  () => import("./ModelThumb").then((module) => module.ModelThumb),
  <span className="peek-model" />,
)

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
