import type { NodeProps } from "@xyflow/react"
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react"

import { useTileOnScreen, type TileVisibility } from "../tileVisibility"
import type { TerminalNode } from "./types"

// Terminal content comes from the canvas's current render, not from node data: node data
// reaches XYFlow a commit later, which would briefly show controlled inputs stale values.
export const TerminalContent = createContext<(id: string, onScreen: boolean) => ReactNode>(
  () => null,
)

export const NodeVisibilityContext = createContext<TileVisibility>({
  watch: () => () => {},
  subscribe: () => () => {},
  select: () => {},
  onScreen: () => true,
})

const TerminalNodeView = ({ id, data, selected }: NodeProps<TerminalNode>): React.JSX.Element => {
  const contentOf = useContext(TerminalContent)
  const content = useRef<HTMLDivElement>(null)
  const visibility = useContext(NodeVisibilityContext)
  // Hidden once out of sight for a while (useTileOnScreen).
  const { onScreen, offScreen } = useTileOnScreen(visibility, id, content)
  useEffect(() => {
    if (data.focusRequest === null) return
    content.current?.closest<HTMLElement>(".react-flow__node")?.focus({ preventScroll: true })
  }, [data.focusRequest])
  return (
    <div
      ref={content}
      data-workspace-canvas-node
      data-node={id}
      data-preview={data.preview}
      data-team={data.team}
      inert={data.hiding}
      aria-hidden={data.hiding}
      className={`canvas-node relative h-full w-full ${selected ? "selected" : ""}`}
    >
      <div
        className="terminal-visibility relative h-full w-full"
        data-hiding={data.hiding}
        data-off-screen={offScreen || undefined}
      >
        {contentOf(id, onScreen)}
      </div>
    </div>
  )
}
export const nodeTypes = { terminal: TerminalNodeView }
