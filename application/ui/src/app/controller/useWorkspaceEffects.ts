import { useEffect, useRef } from "react"

import { cancelTerminalTransition } from "../../layouts/transition"
import { currentContext, currentPresentation, currentState, shallowEqual } from "../selectors"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./context"

// Reactions that must run after React commits, with the same timing as before the
// stores: renames left behind save themselves, stale Canvas focus requests expire,
// and Back/Forward cancels a running view transition.
export const useWorkspaceEffects = (): void => {
  const { commands } = useWorkspaceServices()
  const { finishRename, dropCanvasFocus } = commands
  const { context, view, selected, terminals, presentation } = useWorkspaceState(
    (workspace) => ({
      context: currentContext(workspace),
      view: currentState(workspace).view,
      selected: currentState(workspace).selected,
      terminals: currentState(workspace).roster.terminals,
      presentation: currentPresentation(workspace),
    }),
    shallowEqual,
  )
  const renameSession = useUiState((state) => state.rename)
  const canvasKeyboardFocus = useUiState((state) => state.shell.canvasKeyboardFocus)
  const navigationType = useUiState((state) => state.location.navigationType)
  const activeRename = renameSession?.context === context ? renameSession : null

  // A rename left behind by a session, view or terminal change saves itself.
  useEffect(() => {
    if (!renameSession) return
    if (
      renameSession.context === context &&
      renameSession.view === view &&
      terminals.some((terminal) => terminal.id === renameSession.id)
    )
      return
    let canceled = false
    queueMicrotask(() => {
      if (!canceled) finishRename(renameSession, true)
    })
    return () => {
      canceled = true
    }
  }, [context, finishRename, renameSession, terminals, view])

  // So does one whose terminal is no longer selected.
  const lastSelectedForRename = useRef(selected)
  useEffect(() => {
    const changed = lastSelectedForRename.current !== selected
    lastSelectedForRename.current = selected
    if (!changed || !activeRename || activeRename.id === selected) return
    let canceled = false
    queueMicrotask(() => {
      if (!canceled) finishRename(activeRename, true)
    })
    return () => {
      canceled = true
    }
  }, [activeRename, finishRename, selected])

  // Canvas focus requests last only while Canvas shows the terminal they name.
  useEffect(() => {
    if (!canvasKeyboardFocus) return
    if (
      canvasKeyboardFocus.context === context &&
      view === "canvas" &&
      canvasKeyboardFocus.id === selected
    )
      return
    const request = canvasKeyboardFocus.request
    queueMicrotask(() => dropCanvasFocus(request))
  }, [canvasKeyboardFocus, context, dropCanvasFocus, selected, view])

  useEffect(() => {
    if (navigationType === "POP" && presentation) cancelTerminalTransition()
  }, [navigationType, presentation])
}
