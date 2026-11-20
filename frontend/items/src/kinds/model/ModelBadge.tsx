import { bytesText } from "@novadeck/core/command-text"
import type { ModelContent } from "@novadeck/core/items"
import { Box } from "lucide-react"

/** The names of formats, as the pane's note and a peek's badge say them. */
export const formatNames: Record<ModelContent["format"], string> = {
  glb: "glTF",
  gltf: "glTF",
  stl: "STL",
  obj: "OBJ",
  ply: "PLY",
  "3mf": "3MF",
}

/** All a model's bytes, its own and those of the files beside it. */
export const totalOf = (content: ModelContent): number =>
  content.files.reduce((all, file) => all + file.size, content.size)

// A model's badge in its peek: its format and size, till a still of it is drawn, or in place of
// one past what a peek reads.
export const ModelBadge = ({ content }: { readonly content: ModelContent }): React.JSX.Element => (
  <span className="peek-model">
    <Box size={18} strokeWidth={1.5} aria-hidden />
    <span>{formatNames[content.format]}</span>
    <span>{bytesText(totalOf(content))}</span>
  </span>
)
