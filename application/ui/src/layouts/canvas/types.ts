import type { Node } from "@xyflow/react"
import type { Dispatch, SetStateAction, Ref, ReactNode } from "react"

import type { SizePreset, TerminalMetadata, CanvasLayout } from "../../model/types"
import type { TerminalLayoutControls } from "../../terminals/WindowShell"

export type TerminalNode = Node<
  {
    compactHeader: boolean
    minimized: boolean
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
  matchCreatedTerminalRatio: boolean
  revealOnMount: boolean
  fitOnNavigate: boolean
  onLayoutChange: Dispatch<SetStateAction<CanvasLayout>>
  terminals: TerminalMetadata[]
  hidden: Record<string, boolean>
  preview: string
  selected: string
  keyboardFocusRequest: number | null
  navigation: number
  onSelect: (id: string) => void
  onCreate: () => string
  render: (terminal: TerminalMetadata, controls: TerminalLayoutControls) => ReactNode
}
export type CanvasViewport = NonNullable<CanvasLayout["viewport"]>
export type CanvasHandle = {
  returnToOrigin: () => boolean
}
export type TerminalCanvasProps = CanvasProps & { handleRef: Ref<CanvasHandle> }
