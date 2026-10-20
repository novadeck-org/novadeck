import type { Team } from "@novadeck/core/derivations"
import type { SizePreset, Tile, CanvasLayout } from "@novadeck/core/types"
import type { Node } from "@xyflow/react"
import type { Dispatch, SetStateAction, Ref, ReactNode } from "react"

import type { TerminalLayoutControls } from "../../terminals/WindowShell"

export type TerminalNode = Node<
  {
    compactHeader: boolean
    hiding: boolean
    preview: boolean
    // What the window is in the selected terminal's team, if it is in it.
    team: "lead" | "worker" | undefined
    focusRequest: number | null
    onResizeStart: () => void
    onResizeEnd: (width: number, height: number) => void
  },
  "terminal"
>
export type CanvasProps = {
  presets: Record<string, SizePreset>
  onPresetChange: (id: string, preset: SizePreset) => void
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
  // The selected terminal's team, which the canvas wires.
  team: Team | undefined
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
