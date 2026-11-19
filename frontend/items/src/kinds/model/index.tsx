import { Box } from "lucide-react"
import { lazy, Suspense, type ComponentProps } from "react"

import { artifactLook, artifactThumb, artifactView } from "../../ArtifactViewer"
import type { ItemRegistration } from "../../registration"
import { ModelBadge } from "./ModelBadge"

// The 3D viewer and the peek's stills load when a model first shows, so the workspace never
// pays for them; till then a peek wears its badge, as it does till its still is drawn.
const ModelViewer = lazy(() =>
  import("./ModelViewer").then((module) => ({ default: module.ModelViewer })),
)
const ModelThumb = lazy(() =>
  import("./ModelThumb").then((module) => ({ default: module.ModelThumb })),
)

const LazyViewer = (props: ComponentProps<typeof ModelViewer>): React.JSX.Element => (
  <Suspense fallback={<div className="model-pane" aria-busy />}>
    <ModelViewer {...props} />
  </Suspense>
)

const LazyThumb = (props: ComponentProps<typeof ModelThumb>): React.JSX.Element => (
  <Suspense fallback={<ModelBadge content={props.content} />}>
    <ModelThumb {...props} />
  </Suspense>
)

// A 3D model an agent showed (glTF, STL, OBJ, PLY or 3MF), drawn in the round with the 3D viewer.
export const model = {
  kind: "model",
  names: { one: "3D model", many: "3D models" },
  icon: () => Box,
  stackIcon: Box,
  look: artifactLook,
  Thumb: artifactThumb("model", LazyThumb),
  View: artifactView("model", LazyViewer),
} satisfies ItemRegistration<"model">
