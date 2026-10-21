import type { Team } from "@novadeck/core/derivations"
import type { WindowSize } from "@novadeck/core/layout/terminal-size"
import type { Tile, CanvasLayout } from "@novadeck/core/types"
import type { Node } from "@xyflow/react"
import type { Dispatch, SetStateAction, Ref, ReactNode } from "react"

import type { TerminalLayoutControls } from "../../terminals/WindowShell"

export type TerminalNode = Node<
  {
    compactHeader: boolean
    hiding: boolean
    preview: boolean
    // What the window is in the selected terminal's team, if it is in it: those windows stay
    // bright.
    team: "lead" | "worker" | undefined
    focusRequest: number | null
    onResizeStart: () => void
    onResizeEnd: (width: number, height: number) => void
  },
  "terminal"
>
export type CanvasProps = {
  // The size a new window opens at, and where a window the person resized says its size,
  // which new windows open at from then on.
  windowSize: WindowSize
  onWindowResize: (size: WindowSize) => void
  layout: CanvasLayout
  revealOnMount: boolean
  // Opened from another view: it frames every visible window as it mounts.
  fitOnMount: boolean
  fitOnNavigate: boolean
  // Navigation flies the camera in to the selection, as a header's double-click does.
  flyOnNavigate: boolean
  onLayoutChange: Dispatch<SetStateAction<CanvasLayout>>
  terminals: readonly Tile[]
  hidden: Record<string, boolean>
  preview: string
  selected: string
  // The selected terminal's team, if it has one: its pulse plays and its windows and wire
  // stay bright while the others recede.
  team: Team | undefined
  // Every team, whose wires the canvas draws whatever is selected.
  teams: readonly Team[]
  keyboardFocusRequest: number | null
  navigation: number
  onSelect: (id: string) => void
  onCreate: () => string
  render: (terminal: Tile, controls: TerminalLayoutControls) => ReactNode
}
export type CanvasViewport = NonNullable<CanvasLayout["viewport"]>
export type CanvasHandle = {
  returnToOrigin: () => boolean
}
export type TerminalCanvasProps = CanvasProps & { handleRef: Ref<CanvasHandle> }
