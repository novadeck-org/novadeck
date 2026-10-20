import { AttachedHost } from "@novadeck/companion/TerminalCompanion"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { NodeResizeControl, type NodeProps } from "@xyflow/react"
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import type { NodeVisibility } from "./nodeVisibility"
import type { TerminalNode } from "./types"

// Terminal content comes from the canvas's current render, not from node data: node data
// reaches XYFlow a commit later, which would briefly show controlled inputs stale values.
export const TerminalContent = createContext<(id: string, onScreen: boolean) => ReactNode>(
  () => null,
)

export const NodeVisibilityContext = createContext<NodeVisibility>({
  watch: () => () => {},
  subscribe: () => () => {},
  onScreen: () => true,
})

// How long a node out of sight waits before its content stops being laid out: past the 5 s
// a runner screen nobody shows keeps following before it parks (`parkMs`, in
// libraries/terminal/src/view/screens.ts, which a layout does not import), so the screen has measured and
// parked first.
const hideMs = 6_000

const TerminalNodeView = ({ id, data, selected }: NodeProps<TerminalNode>): React.JSX.Element => {
  const contentOf = useContext(TerminalContent)
  const content = useRef<HTMLDivElement>(null)
  // What the terminal's companion hangs beside it: here, outside the window's clipping and
  // the content-visibility that hides the window off screen.
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => setHost(content.current), [])
  const visibility = useContext(NodeVisibilityContext)
  const reported = useSyncExternalStore(visibility.subscribe, () => visibility.onScreen(id))
  // A node the observer has not reported on has not been seen: its screen opens once it is.
  const onScreen = reported === true
  const [waited, setWaited] = useState(false)
  // Hidden once out of sight for a while. It shows again in the render that sees it back,
  // before its surface takes its screen, so xterm measures a laid-out element.
  const offScreen = reported === false && waited
  useEffect(() => {
    const element = content.current
    return element ? visibility.watch(id, element) : undefined
  }, [visibility, id])
  useEffect(() => {
    if (reported !== false) return
    const timer = setTimeout(() => setWaited(true), hideMs)
    return () => {
      clearTimeout(timer)
      setWaited(false)
    }
  }, [reported])
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
      inert={data.hiding}
      aria-hidden={data.hiding}
      className={`canvas-node relative h-full w-full ${selected ? "selected" : ""} ${data.compactHeader ? "compact-header" : ""}`}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div
        className="terminal-visibility relative h-full w-full"
        data-hiding={data.hiding}
        data-off-screen={offScreen || undefined}
      >
        <NodeResizeControl
          position="bottom-right"
          minWidth={320}
          minHeight={200}
          autoScale={false}
          className="terminal-resize-grip nodrag nopan"
          onResizeStart={data.onResizeStart}
          onResizeEnd={(_, { width, height }) => data.onResizeEnd(width, height)}
        >
          <Tooltip content="Resize">
            <span className="terminal-resize-pattern" />
          </Tooltip>
        </NodeResizeControl>
        <AttachedHost.Provider value={host}>{contentOf(id, onScreen)}</AttachedHost.Provider>
      </div>
    </div>
  )
}
export const nodeTypes = { terminal: TerminalNodeView }
