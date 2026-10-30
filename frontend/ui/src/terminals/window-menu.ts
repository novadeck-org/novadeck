import { titleSourceText } from "@novadeck/core/terminals/title-source"
import type { Tile } from "@novadeck/core/types"
import type { ContextMenuAction } from "@novadeck/toolkit/ContextMenu"
import { MessageSquareText } from "lucide-react"
import { createElement } from "react"

import { isProjectWindow } from "./project-window"

// Where a window undocked from a terminal's companion docks back in: that terminal's
// name, and what docks it there, both absent once that terminal has closed.
export type DockTarget = {
  readonly name: string | undefined
  readonly onDock: (() => void) | undefined
}

// Ending the lead of a led terminal: its lead's handle, which the item names, and what
// releases it.
export type ReleaseLead = {
  readonly lead: string
  readonly onRelease: () => void
}

// Asking the agent in a window to write feedback: its handle, which the item names, and what
// opens the card.
export type AskFeedback = {
  readonly handle: string
  readonly onAsk: () => void
}

// A window's own actions, the same in its sidebar tab's menu and its header's: who named
// it, as a line to read rather than choose, then rename, hand a name the person gave back
// to Novadeck, dock an undocked window back in its terminal, release a terminal from its
// lead, and close. The project
// window is named by its file and has no terminal to dock in: it offers Close alone. A window
// running an agent, on a backend that takes feedback, can ask it to write some. The menu
// takes only text for a label, so the handle is plain `@handle` there, not the chip.
export const windowMenu = ({
  terminal,
  onRename,
  onResetTitle,
  dockIn,
  askFeedback,
  releaseLead,
  onClose,
}: {
  terminal: Tile
  onRename: () => void
  // Absent where the backend can't take a name back.
  onResetTitle?: (() => void) | undefined
  // Present on a window undocked from a terminal's companion.
  dockIn?: DockTarget | undefined
  // Present on a window running an agent, where the backend takes feedback.
  askFeedback?: AskFeedback | undefined
  // Present on a terminal an agent leads, where the backend lets the person end that.
  releaseLead?: ReleaseLead | undefined
  onClose: () => void
}): ContextMenuAction[] =>
  isProjectWindow(terminal)
    ? [{ value: "close", label: "Close", onSelect: onClose }]
    : [
        // A name nobody chose says nothing worth a line.
        ...(terminal.titleSource && terminal.titleSource.kind !== "default"
          ? [
              {
                value: "named",
                label: titleSourceText(terminal.titleSource),
                disabled: true,
                onSelect: () => {},
              },
            ]
          : []),
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
        ...(askFeedback
          ? [
              {
                value: "ask-feedback",
                label: `Ask @${askFeedback.handle} to write feedback…`,
                icon: createElement(MessageSquareText, { size: 14, strokeWidth: 1.5 }),
                onSelect: askFeedback.onAsk,
              },
            ]
          : []),
        ...(releaseLead
          ? [
              {
                value: "release-lead",
                label: `Release from @${releaseLead.lead}`,
                onSelect: releaseLead.onRelease,
              },
            ]
          : []),
        { value: "close", label: "Close", onSelect: onClose },
      ]
