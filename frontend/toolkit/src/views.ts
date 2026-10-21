import { LayoutGrid, PanelLeft, SquareDashedMousePointer } from "lucide-react"

// How each layout presents itself wherever the person picks one: the header's switch, Zen's
// dock, Preferences and the welcome preview all show the same name and icon.
export const views = [
  { id: "focus", label: "Focus", icon: PanelLeft },
  { id: "grid", label: "Grid", icon: LayoutGrid },
  { id: "canvas", label: "Canvas", icon: SquareDashedMousePointer },
] as const

export type ViewPresentation = (typeof views)[number]
