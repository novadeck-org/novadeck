import type { Team } from "@novadeck/core/derivations"
import type { Tile, CanvasLayout } from "@novadeck/core/types"
import type { Node, Viewport } from "@xyflow/react"
import type { Ref, ReactNode } from "react"

import type { TerminalLayoutControls } from "../../terminals/WindowShell"
import type { HeldStay } from "./stay"

export type TerminalNode = Node<
  {
    hiding: boolean
    preview: boolean
    // What the window is in the selected terminal's team, if it is in it: those windows stay
    // bright.
    team: "lead" | "worker" | undefined
    focusRequest: number | null
  },
  "terminal"
>
export type CanvasProps = {
  // Where a window was dropped on it, which it reads as the drop; it arranges its windows
  // itself and saves nothing of that, nor of its camera.
  layout: CanvasLayout
  // Come back to from Focus by a window's own button: it opens as it was left, its camera
  // and its windows. Otherwise it arranges its windows afresh and frames them all.
  revealOnMount: boolean
  // The session's stay on Canvas, which outlives this view.
  stay: HeldStay
  // Each increment says the person reordered the sidebar: the windows are arranged afresh.
  reordered: number
  fitOnNavigate: boolean
  // Navigation flies the camera in to the selection, as a header's double-click does.
  flyOnNavigate: boolean
  // The session's terminals and windows, in the sidebar's order.
  terminals: readonly Tile[]
  hidden: Record<string, boolean>
  preview: string
  selected: string
  // The selected terminal's team, if it has one: its wire lights, and its windows and wire
  // stay bright while the others recede.
  team: Team | undefined
  // Every team, whose wires the canvas draws whatever is selected.
  teams: readonly Team[]
  // Whether terminals' windows draw their handles' critters (Agent avatars, experimental),
  // which grow past their corners once zoomed out.
  avatars: boolean
  keyboardFocusRequest: number | null
  navigation: number
  onSelect: (id: string) => void
  render: (terminal: Tile, controls: TerminalLayoutControls) => ReactNode
}
export type CanvasViewport = Viewport
export type CanvasHandle = {
  returnToOrigin: () => boolean
}
export type TerminalCanvasProps = CanvasProps & { handleRef: Ref<CanvasHandle> }
