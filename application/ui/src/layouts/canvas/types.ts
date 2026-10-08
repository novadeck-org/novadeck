import type { Node } from "@xyflow/react"
import type { Dispatch, SetStateAction, Ref, ReactNode } from "react"

import type { SizePreset, Tile, CanvasLayout } from "../../model/types"
import type { TerminalLayoutControls } from "../../terminals/WindowShell"

export type TerminalNode = Node<
  {
    compactHeader: boolean
    hiding: boolean
    preview: boolean
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
  onLayoutChange: Dispatch<SetStateAction<CanvasLayout>>
  terminals: readonly Tile[]
  hidden: Record<string, boolean>
  preview: string
  selected: string
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
