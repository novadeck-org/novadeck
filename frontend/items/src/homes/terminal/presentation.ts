import type { ViewMode } from "@novadeck/core/types"

// Where a terminal's pane opens: beside the terminal inside its window, or hanging off a
// canvas node.
export type PlanPresentation = "split" | "attached"

// Beside the terminal, or on the canvas, attached to the terminal's node.
export const presentationOf = (view: ViewMode): PlanPresentation =>
  view === "canvas" ? "attached" : "split"
