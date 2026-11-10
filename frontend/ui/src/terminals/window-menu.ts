import { titleSourceText } from "@novadeck/core/terminals/title-source"
import type { Tile } from "@novadeck/core/types"
import type { ContextMenuItem } from "@novadeck/toolkit/ContextMenu"
import { MessageSquareText, Plus } from "lucide-react"
import type { ReactNode } from "react"
import { createElement, Fragment } from "react"

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

// Folding a lead's teammates out of the Terminals list, or showing them again: how many it
// leads, whether they're folded, and what turns it over. Only on a lead.
export type FoldTeam = {
  readonly count: number
  readonly folded: boolean
  readonly onToggle: () => void
}

// Moving a terminal to another session of its project: the sessions its menu offers, most
// recently visited first, each with what its terminals show at a glance and how many there
// are; whether there are more than it lists, which "All sessions…" picks from; how many
// teammates a lead takes along; and what moves it, to a session or a new one, or opens the
// pick.
export type MoveTo = {
  readonly sessions: readonly {
    readonly id: string
    readonly name: string
    readonly count: number
    readonly mark?: ReactNode
  }[]
  readonly more: boolean
  readonly team: number
  readonly onMove: (to: { readonly sessionId: string } | { readonly fresh: true }) => void
  readonly onPick: () => void
}

// The move's submenu: a new session, named after the terminal, first; then the sessions; then
// all of them, in the Sessions panel.
const moveItem = (moveTo: MoveTo): ContextMenuItem => ({
  value: "move",
  label: moveTo.team ? "Move team to session" : "Move to session",
  items: [
    ...(moveTo.team
      ? [
          {
            value: "move-team",
            label: `With ${moveTo.team} ${moveTo.team === 1 ? "teammate" : "teammates"}`,
            disabled: true,
            onSelect: () => {},
          },
        ]
      : []),
    {
      value: "move-new",
      label: "New session",
      icon: createElement(Plus, { size: 14, strokeWidth: 1.5 }),
      onSelect: () => moveTo.onMove({ fresh: true }),
    },
    ...moveTo.sessions.map((session, index) => ({
      value: `move-to-${session.id}`,
      label: session.name,
      separated: index === 0,
      detail: createElement(Fragment, null, session.mark, String(session.count)),
      onSelect: () => moveTo.onMove({ sessionId: session.id }),
    })),
    ...(moveTo.more
      ? [{ value: "move-all", label: "All sessions…", separated: true, onSelect: moveTo.onPick }]
      : []),
  ],
})

// A window's own actions, the same in its sidebar tab's menu and its header's: who named
// it, as a line to read rather than choose, then rename, hand a name the person gave back
// to Novadeck, dock an undocked window back in its terminal, release a terminal from its
// lead, fold a lead's teammates out of the list, and close. The project window is named by its file and has no terminal to dock in:
// it offers Close alone. A window running an agent, on a backend that takes feedback, can
// ask it to write some. The menu takes only text for a label, so the handle is plain
// `@handle` there, not the chip.
export const windowMenu = ({
  terminal,
  onRename,
  onResetTitle,
  dockIn,
  askFeedback,
  releaseLead,
  foldTeam,
  moveTo,
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
  // Present on a lead: folds its teammates' tabs out of the list, or shows them again. The
  // keyboard's way to it, as pointing beside the lead's tab is the pointer's.
  foldTeam?: FoldTeam | undefined
  // Present where the backend moves terminals between sessions, on a terminal, not a window.
  moveTo?: MoveTo | undefined
  onClose: () => void
}): ContextMenuItem[] =>
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
        ...(foldTeam
          ? [
              {
                value: "fold-team",
                label: `${foldTeam.folded ? "Show" : "Fold"} ${foldTeam.count} ${foldTeam.count === 1 ? "teammate" : "teammates"}`,
                onSelect: foldTeam.onToggle,
              },
            ]
          : []),
        ...(moveTo ? [moveItem(moveTo)] : []),
        { value: "close", label: "Close", onSelect: onClose },
      ]
