import type { Tile } from "../model/types"
import type { ContextMenuItem } from "../ui-toolkit/ContextMenu"

// Where a window undocked from a terminal's companion docks back in: that terminal's
// name, and what docks it there, both absent once that terminal has closed.
export type DockTarget = {
  readonly name: string | undefined
  readonly onDock: (() => void) | undefined
}

// A window's own actions, the same in its sidebar tab's menu and its header's: rename,
// hand a name the person gave back to Novadeck, dock an undocked window back in its
// terminal, and close.
export const windowMenu = ({
  terminal,
  onRename,
  onResetTitle,
  dockIn,
  onClose,
}: {
  terminal: Tile
  onRename: () => void
  // Absent where the backend can't take a name back.
  onResetTitle?: (() => void) | undefined
  // Present on a window undocked from a terminal's companion.
  dockIn?: DockTarget | undefined
  onClose: () => void
}): ContextMenuItem[] => [
  { value: "rename", label: "Rename", onSelect: onRename },
  ...(onResetTitle && terminal.titleSource?.kind === "person"
    ? [{ value: "reset-title", label: "Reset to automatic", onSelect: onResetTitle }]
    : []),
  ...(dockIn
    ? [
        {
          value: "dock",
          // Its terminal closed: there's nowhere to dock it, so it says so, disabled.
          label: dockIn.name ? `Dock in ${dockIn.name}` : "Dock in its terminal (closed)",
          disabled: !dockIn.onDock,
          onSelect: () => dockIn.onDock?.(),
        },
      ]
    : []),
  { value: "close", label: "Close", onSelect: onClose },
]
