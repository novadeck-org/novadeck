import { useMemo, useState, type ReactNode } from "react"

import type { Tile } from "#core/types"

import type { TerminalLayoutControls } from "../../terminals/WindowShell"
import { Shown, useShown } from "../../ui-toolkit/shown"
import { backgroundPointerHandlers } from "../background"
import { useTerminalVisibility } from "../useTerminalVisibility"
import { keptTerminals } from "./kept"

// Focus offers its windows no layout controls; one object for all, so a window whose
// terminal didn't change skips rendering again.
const controls: TerminalLayoutControls = {}

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
  // Shown only while Focus itself is.
  const shown = useShown()
  const ids = useMemo(() => terminals.map((terminal) => terminal.id), [terminals])
  const [kept, setKept] = useState<readonly string[]>(() => [displayed])
  const keeping = keptTerminals(kept, displayed, ids)
  if (keeping !== kept) setKept(keeping)
  return (
    <div
      data-workspace-viewport
      className="focus-stage relative min-h-0 flex-1 overflow-clip workspace-background"
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
      {/* Once hidden, a terminal Focus keeps is parked out of sight instead of unmounting. */}
      {terminals
        .filter((terminal) => !removed[terminal.id] || keeping.includes(terminal.id))
        .map((terminal) => (
          <div
            key={terminal.id}
            className="terminal-visibility absolute data-[hiding=false]:z-1"
            data-hiding={hidden[terminal.id]}
            data-parked={removed[terminal.id] || undefined}
            aria-hidden={hidden[terminal.id]}
            inert={hidden[terminal.id]}
          >
            <Shown value={shown && !hidden[terminal.id]}>{render(terminal, controls)}</Shown>
          </div>
        ))}
    </div>
  )
}
