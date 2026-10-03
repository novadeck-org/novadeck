import { useMemo, type ReactNode } from "react"

import type { Tile } from "../../model/types"
import type { TerminalLayoutControls } from "../../terminals/WindowShell"
import { backgroundPointerHandlers } from "../background"
import { useTerminalVisibility } from "../useTerminalVisibility"

export const Focus = ({
  terminals,
  displayed,
  onSelect,
  render,
}: {
  terminals: readonly Tile[]
  displayed: string
  onSelect: (id: string) => void
  render: (terminal: Tile, controls: TerminalLayoutControls) => ReactNode
}): React.JSX.Element => {
  const hidden = useMemo(
    () => Object.fromEntries(terminals.map((terminal) => [terminal.id, terminal.id !== displayed])),
    [terminals, displayed],
  )
  const removed = useTerminalVisibility(hidden)
  return (
    <div
      data-workspace-viewport
      className="focus-stage relative min-h-0 flex-1 overflow-hidden workspace-background"
      {...backgroundPointerHandlers}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        if ((event.target as Element).closest("[data-terminal]")) onSelect(displayed)
      }}
      onFocusCapture={(event) => {
        if ((event.target as Element).closest("[data-terminal]")) onSelect(displayed)
      }}
    >
      <div className="workspace-dots absolute inset-0 canvas-grid" aria-hidden="true" />
      <div className="workspace-dots absolute inset-0 canvas-grid-spotlight" aria-hidden="true" />
      {terminals
        .filter((terminal) => !removed[terminal.id])
        .map((terminal) => (
          <div
            key={terminal.id}
            className="terminal-visibility absolute data-[hiding=false]:z-1"
            data-hiding={hidden[terminal.id]}
            aria-hidden={hidden[terminal.id]}
            inert={hidden[terminal.id]}
          >
            {render(terminal, {})}
          </div>
        ))}
    </div>
  )
}
