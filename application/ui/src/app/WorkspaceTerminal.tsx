import { useCallback, useMemo, type ReactNode } from "react"

import { isWindow } from "../model/roster"
import { activeProject } from "../model/state"
import type { CompanionWindowMeta, TerminalMetadata, Tile } from "../model/types"
import { TerminalCompanion } from "../terminals/companion/TerminalCompanion"
import { UndockedWindow } from "../terminals/companion/UndockedWindow"
import { presentedProgram, terminalProfile, windowProfile } from "../terminals/processes/profiles"
import { renameView } from "../terminals/rename-state"
import { unreadEnd } from "../terminals/unread-state"
import { windowMenu } from "../terminals/window-menu"
import {
  WindowShell,
  type TerminalLayoutControls,
  type WindowShellProps,
} from "../terminals/WindowShell"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useDockTarget } from "./dock-target"
import {
  currentContext,
  currentState,
  currentTarget,
  handleNames,
  sameTarget,
  shallowEqual,
  terminalNames,
  windowedDestination,
} from "./selectors"
import { useTerminalBar } from "./terminal-bar"

// What every window in the current view takes from the workspace, a terminal's or one
// undocked from a companion: its header, its menu, and the controls its layout offers.
const useWindowFrame = (
  tile: Tile,
  { minimize, onFlyTo, onResizePreset }: TerminalLayoutControls,
): Omit<WindowShellProps, "children" | "icon"> => {
  const { backend, commands } = useWorkspaceServices()
  const { setSelected, openWindowed, openFocus, close, startRename, openSwitcher } = commands
  const { resetTitle, changeRenameDraft, saveRename, cancelRename } = commands
  const id = tile.id
  const { context, view, windowedView, active, large } = useWorkspaceState((workspace) => {
    const state = currentState(workspace)
    return {
      context: currentContext(workspace),
      view: state.view,
      windowedView: state.windowedView,
      active: state.selected === id,
      large: state.view !== "focus" && state.layout.sizePresets[state.view][id] === "large",
    }
  }, shallowEqual)
  const { fresh, rename, enabledViews, unread } = useUiState(
    (state) => ({
      fresh: state.created?.context === context && state.created.id === id,
      rename: state.rename?.context === context && state.rename.id === id ? state.rename : null,
      enabledViews: state.preferences.enabledViews,
      unread: unreadEnd(state.unread, context, id),
    }),
    shallowEqual,
  )
  const compact = view !== "focus"
  const destination = windowedDestination(windowedView, enabledViews)
  const windowedLabel = destination === "canvas" ? "Canvas" : "Grid"
  const dockIn = useDockTarget(tile)
  return {
    terminal: tile,
    active,
    fresh,
    unread,
    rename: renameView(rename),
    onBeginRename: () => startRename(tile, "header"),
    onRenameDraft: (draft) => changeRenameDraft(id, draft),
    onRenameSave: () => saveRename(id),
    onRenameCancel: () => cancelRename(id),
    menu: windowMenu({
      terminal: tile,
      onRename: () => startRename(tile, "header"),
      onResetTitle: backend.resetTitle ? () => resetTitle(id) : undefined,
      dockIn,
      onClose: () => close(id),
    }),
    compact,
    switcher: { onOpen: (button) => openSwitcher(id, button) },
    onClose: () => close(id),
    ...(minimize ? { minimize } : {}),
    ...(onFlyTo ? { onFlyTo } : {}),
    ...(onResizePreset
      ? {
          onResizePreset: (button: HTMLButtonElement) => {
            setSelected(id)
            onResizePreset(button)
          },
          resizeView: view === "grid" ? ("grid" as const) : ("canvas" as const),
        }
      : {}),
    large,
    ...(compact && enabledViews.includes("focus")
      ? { onFocus: () => openFocus(id) }
      : !compact && destination
        ? { windowed: { destination: windowedLabel, onOpen: () => openWindowed(id) } }
        : {}),
  }
}

// A window undocked from a terminal's companion, in the same frame as a terminal's.
const WorkspaceWindow = ({
  window,
  controls,
}: {
  readonly window: CompanionWindowMeta
  readonly controls: TerminalLayoutControls
}): React.JSX.Element => {
  const { panes } = useWorkspaceServices()
  const frame = useWindowFrame(window, controls)
  const target = useWorkspaceState(currentTarget, sameTarget)
  const item = useWorkspaceState((workspace) =>
    currentState(workspace).items.find((each) => each.id === window.itemId),
  )
  const { icon: Icon } = windowProfile(item)
  // What it shows, where a terminal's content would be.
  return (
    <WindowShell {...frame} icon={<Icon size={14} strokeWidth={1.5} />}>
      {panes && <UndockedWindow panes={panes} target={target} item={item} />}
    </WindowShell>
  )
}

// One terminal in the current view: the backend's surface, which keeps its controller
// mounted while the shared window, and the body its program calls for, wrap its content.
export const WorkspaceTerminal = ({
  terminal,
  controls,
}: {
  readonly terminal: TerminalMetadata
  readonly controls: TerminalLayoutControls
}): React.JSX.Element => {
  const { minimize, onReveal } = controls
  const { backend, commands, panes } = useWorkspaceServices()
  const { setKeyboardFocus } = commands
  const terminalId = terminal.id
  // Each terminal selects only what concerns it, so a rename keystroke or a keyboard
  // focus change re-renders just the terminals involved.
  const { projectName, view, active } = useWorkspaceState((workspace) => {
    const state = currentState(workspace)
    return {
      projectName: activeProject(workspace)!.name,
      view: state.view,
      active: state.selected === terminalId,
    }
  }, shallowEqual)
  const { projectId, workspaceSessionId } = useWorkspaceState(currentTarget, sameTarget)
  const terminalName = useWorkspaceState(terminalNames, shallowEqual)
  const names = useWorkspaceState(handleNames, shallowEqual)
  const { keyboardFocus, fontSize } = useUiState(
    (state) => ({
      keyboardFocus:
        state.shell.keyboardFocus?.id === terminalId ? state.shell.keyboardFocus : null,
      fontSize: state.preferences.fontSize,
    }),
    shallowEqual,
  )
  // Surfaces may depend on these in effects, so keep them stable across renders.
  const terminalKey = useMemo(
    () => ({ projectId, workspaceSessionId, terminalId }),
    [projectId, workspaceSessionId, terminalId],
  )
  const onInputFocused = useCallback(() => setKeyboardFocus(null), [setKeyboardFocus])
  const { bar, items, fresh } = useTerminalBar(terminalId)
  const { icon: Icon, Body } = terminalProfile(terminal)
  const processWindow = presentedProgram(terminal)
  const frame: Omit<WindowShellProps, "children"> = {
    ...useWindowFrame(terminal, controls),
    icon: <Icon size={14} strokeWidth={1.5} />,
    ...(processWindow ? { processWindow } : {}),
  }
  // One shell element whatever runs, so only the body around the content changes.
  const renderWindow = (content: ReactNode): ReactNode => (
    <WindowShell {...frame}>
      {panes ? (
        <TerminalCompanion
          panes={panes}
          messages={backend.messages}
          peerName={(handle) => names[handle]}
          companionKey={terminalKey}
          view={view}
          onReveal={onReveal}
          minimized={minimize?.minimized}
          clipContent={minimize?.clipContent}
          bar={bar}
          items={items}
          fresh={fresh}
          terminalName={(id) => terminalName[id]}
          commands={commands}
        >
          {Body ? <Body>{content}</Body> : content}
        </TerminalCompanion>
      ) : Body ? (
        <Body>{content}</Body>
      ) : (
        content
      )}
    </WindowShell>
  )
  return (
    <backend.TerminalSurface
      terminalKey={terminalKey}
      terminal={terminal}
      projectName={projectName}
      fontSize={fontSize}
      minimized={minimize?.minimized}
      clipContent={minimize?.clipContent}
      focusInput={keyboardFocus?.view === view && active}
      onInputFocused={onInputFocused}
      renderWindow={renderWindow}
    />
  )
}

// Layouts call this for each terminal and window they place.
export const renderTerminal = (tile: Tile, controls: TerminalLayoutControls): React.JSX.Element =>
  isWindow(tile) ? (
    <WorkspaceWindow key={tile.id} window={tile} controls={controls} />
  ) : (
    <WorkspaceTerminal key={tile.id} terminal={tile} controls={controls} />
  )
