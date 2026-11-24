import type { Tile } from "@novadeck/core/types"
import type { NodeProps } from "@xyflow/react"
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react"

import type { TerminalLayoutControls } from "../../terminals/WindowShell"
import { useTileOnScreen, type TileVisibility } from "../tileVisibility"
import type { TerminalNode } from "./types"
import { keepWheel } from "./wheel"

// What a node draws its window from. Terminal content comes from the canvas's current render,
// not from node data: node data reaches XYFlow a commit later, which would briefly show
// controlled inputs stale values.
export type CanvasContent = {
  readonly tileOf: (id: string) => Tile | undefined
  readonly render: (tile: Tile, controls: TerminalLayoutControls) => ReactNode
  readonly legible: boolean
  // Stable for the canvas's life, so a window's controls change only with its own facts.
  readonly flyTo: (id: string) => void
}

export const TerminalContent = createContext<CanvasContent>({
  tileOf: () => undefined,
  render: () => null,
  legible: true,
  flyTo: () => {},
})

export const NodeVisibilityContext = createContext<TileVisibility>({
  watch: () => () => {},
  subscribe: () => () => {},
  select: () => {},
  onScreen: () => true,
})

const TerminalNodeView = ({ id, data, selected }: NodeProps<TerminalNode>): React.JSX.Element => {
  const { tileOf, render, legible, flyTo } = useContext(TerminalContent)
  const content = useRef<HTMLDivElement>(null)
  const visibility = useContext(NodeVisibilityContext)
  // Hidden once out of sight for a while (useTileOnScreen).
  const { onScreen, offScreen } = useTileOnScreen(visibility, id, content)
  // A window draws again only when its own tile, its sight or the zoom's legibility changes,
  // as Grid's tiles do: every node renders whenever the canvas places its windows (a
  // selection, any terminal's news), and building all of them each time is what made a
  // canvas of many windows lag.
  const tile = tileOf(id)
  const controls = useMemo(
    (): TerminalLayoutControls => ({ onScreen, legible, onFlyTo: () => flyTo(id) }),
    [flyTo, id, legible, onScreen],
  )
  const body = useMemo(() => (tile ? render(tile, controls) : null), [controls, render, tile])
  useEffect(() => {
    const element = content.current
    element?.addEventListener("wheel", keepWheel, { passive: true })
    return () => element?.removeEventListener("wheel", keepWheel)
  }, [])
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
        {body}
      </div>
    </div>
  )
}
export const nodeTypes = { terminal: TerminalNodeView }
