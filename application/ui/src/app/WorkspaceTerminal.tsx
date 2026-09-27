import { useCallback, useMemo } from "react"

import { activeProject } from "../model/state"
import type { TerminalMetadata } from "../model/types"
import { renameView } from "../terminals/rename-state"
import { TerminalFrame, type TerminalLayoutControls } from "../terminals/TerminalFrame"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import {
  currentContext,
  currentState,
  currentTarget,
  sameTarget,
  shallowEqual,
  windowedDestination,
} from "./selectors"

// One terminal in the current view: the shared frame around the backend's surface.
export const WorkspaceTerminal = ({
  terminal,
  controls: { minimize, onFlyTo, onResizePreset },
}: {
  readonly terminal: TerminalMetadata
  readonly controls: TerminalLayoutControls
}): React.JSX.Element => {
  const { backend, commands } = useWorkspaceServices()
  const { setSelected, openWindowed, openFocus, close, startRename, openSwitcher } = commands
  const { changeRenameDraft, saveRename, cancelRename, setKeyboardFocus } = commands
  const terminalId = terminal.id
  // Each terminal selects only what concerns it, so a rename keystroke or a keyboard
  // focus change re-renders just the terminals involved.
  const { projectName, context, view, windowedView, active, large } = useWorkspaceState(
    (workspace) => {
      const state = currentState(workspace)
      return {
        projectName: activeProject(workspace)!.name,
        context: currentContext(workspace),
        view: state.view,
        windowedView: state.windowedView,
        active: state.selected === terminalId,
        large:
          state.view !== "focus" && state.layout.sizePresets[state.view][terminalId] === "large",
      }
    },
    shallowEqual,
  )
  const { projectId, workspaceSessionId } = useWorkspaceState(currentTarget, sameTarget)
  const { fresh, rename, keyboardFocus, enabledViews, fontSize } = useUiState(
    (state) => ({
      fresh: state.created?.context === context && state.created.id === terminalId,
      rename:
        state.rename?.context === context && state.rename.id === terminalId ? state.rename : null,
      keyboardFocus:
        state.shell.keyboardFocus?.id === terminalId ? state.shell.keyboardFocus : null,
      enabledViews: state.preferences.enabledViews,
      fontSize: state.preferences.fontSize,
    }),
    shallowEqual,
  )
  const compact = view !== "focus"
  const destination = windowedDestination(windowedView, enabledViews)
  const windowedLabel = destination === "canvas" ? "Canvas" : "Grid"
  // Surfaces may depend on these in effects, so keep them stable across renders.
  const terminalKey = useMemo(
    () => ({ projectId, workspaceSessionId, terminalId }),
    [projectId, workspaceSessionId, terminalId],
  )
  const onInputFocused = useCallback(() => setKeyboardFocus(null), [setKeyboardFocus])
  return (
    <TerminalFrame
      terminal={terminal}
      active={active}
      fresh={fresh}
      rename={renameView(rename)}
      onBeginRename={() => startRename(terminal, "header")}
      onRenameDraft={(draft) => changeRenameDraft(terminal.id, draft)}
      onRenameSave={() => saveRename(terminal.id)}
      onRenameCancel={() => cancelRename(terminal.id)}
      compact={compact}
      switcher={{ onOpen: (button) => openSwitcher(terminal.id, button) }}
      onClose={() => close(terminal.id)}
      {...(minimize ? { minimize } : {})}
      {...(onFlyTo ? { onFlyTo } : {})}
      {...(onResizePreset
        ? {
            onResizePreset: (button: HTMLButtonElement) => {
              setSelected(terminal.id)
              onResizePreset(button)
            },
            resizeView: view === "grid" ? ("grid" as const) : ("canvas" as const),
          }
        : {})}
      large={large}
      {...(compact && enabledViews.includes("focus")
        ? {
            onFocus: () => openFocus(terminal.id),
          }
        : !compact && destination
          ? {
              windowed: {
                destination: windowedLabel,
                onOpen: () => openWindowed(terminal.id),
              },
            }
          : {})}
    >
      <backend.TerminalSurface
        terminalKey={terminalKey}
        terminal={terminal}
        projectName={projectName}
        fontSize={fontSize}
        minimized={minimize?.minimized}
        clipContent={minimize?.clipContent}
        focusInput={keyboardFocus?.view === view && active}
        onInputFocused={onInputFocused}
      />
    </TerminalFrame>
  )
}

// Layouts call this for each terminal they place.
export const renderTerminal = (
  terminal: TerminalMetadata,
  controls: TerminalLayoutControls,
): React.JSX.Element => (
  <WorkspaceTerminal key={terminal.id} terminal={terminal} controls={controls} />
)
