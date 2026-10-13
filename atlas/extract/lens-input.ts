import type { AgentSurface, Api, Area, Data } from "../src/atlas.ts"
import type { Anchors } from "./anchors.ts"

// What a lens extractor gets: the repository and what the other extractors found.
// `areaOf` names the area token that owns a repository-relative file.
export type LensInput = {
  repo: string
  anchors: Anchors
  api: Api
  data: Data
  agents: AgentSurface
  areas: Area[]
  areaOf: (file: string) => string | null
}
