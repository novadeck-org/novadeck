import { tilesOf } from "@novadeck/core/roster"
import { useEffect, useLayoutEffect, useRef, useState } from "react"

import { cancelTerminalTransition } from "../../layouts/transition"
import { readsToScreenReader } from "../../preferences/screen-reader"
import { currentContext, currentPresentation, currentState, shallowEqual } from "../selectors"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./context"

// Reactions that must run after React commits, with the same timing as before the
// stores: renames left behind save themselves, stale Canvas focus requests expire,
// and Back/Forward cancels a running view transition.
export const useWorkspaceEffects = (): void => {
  const { commands, backend } = useWorkspaceServices()
  const { finishRename, dropCanvasFocus } = commands
  const { context, view, selected, terminals, presentation } = useWorkspaceState(
    (workspace) => ({
      context: currentContext(workspace),
      view: currentState(workspace).view,
      selected: currentState(workspace).selected,
      terminals: tilesOf(currentState(workspace).roster),
      presentation: currentPresentation(workspace),
    }),
    shallowEqual,
  )
  const renameSession = useUiState((state) => state.rename)
  const canvasKeyboardFocus = useUiState((state) => state.shell.canvasKeyboardFocus)
  const navigationType = useUiState((state) => state.location.navigationType)
  const ligatures = useUiState((state) => state.preferences.ligatures)
  const screenReader = useUiState((state) => state.preferences.screenReader)
  // Whether the app says a screen reader runs; undefined where nothing can tell.
  const [readerRunning, setReaderRunning] = useState<boolean | undefined>(undefined)
  const activeRename = renameSession?.context === context ? renameSession : null

  // Ligatures follow the preference on <html>, so dialogs outside the workspace follow it
  // too (theme/base.css); the terminals' screens watch it (terminal-views/ligatures.ts).
  useLayoutEffect(() => {
    document.documentElement.dataset.ligatures = ligatures ? "on" : "off"
  }, [ligatures])

  useEffect(() => backend.screenReader?.(setReaderRunning), [backend])

  // A terminal in focus keeps its text for a screen reader only while one may read it, by the
  // preference and the app's word (terminal-views/emulator.ts watches the attribute): keeping
  // it costs a layout of every row the terminal draws.
  const reads = readsToScreenReader(screenReader, readerRunning)
  useLayoutEffect(() => {
    document.documentElement.dataset.screenReader = reads ? "on" : "off"
  }, [reads])

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
