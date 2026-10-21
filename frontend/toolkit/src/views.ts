import { LayoutGrid, PanelLeft, SquareDashedMousePointer, type LucideIcon } from "lucide-react"

export type ViewPresentation = { readonly label: string; readonly icon: LucideIcon }

// How each layout presents itself wherever the person picks one: the header's switch, Zen's
// dock, Preferences and the welcome preview all show the same name and icon. Keyed by the
// layout, so the UI reads it in the core's order and a layout missing here fails its typecheck.
export const views = {
  focus: { label: "Focus", icon: PanelLeft },
  grid: { label: "Grid", icon: LayoutGrid },
  canvas: { label: "Canvas", icon: SquareDashedMousePointer },
} as const satisfies Record<string, ViewPresentation>
