import type { ViewMode } from "@novadeck/core/types"

// Where a terminal's pane opens: beside the terminal inside its window, or hanging off a
// canvas node.
export type PanePresentation = "split" | "attached"

// Beside the terminal, or on the canvas, attached to the terminal's node.
export const presentationOf = (view: ViewMode): PanePresentation =>
  view === "canvas" ? "attached" : "split"
