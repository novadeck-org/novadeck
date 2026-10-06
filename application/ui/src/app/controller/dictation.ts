import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react"

import type { TerminalKey } from "../../backend/port"
import { tilesOf } from "../../model/roster"
import { activeProject } from "../../model/state"
import type { TerminalMetadata } from "../../model/types"
import { isAgentTerminal } from "../../voice/agent-terminal"
import { startCapture } from "../../voice/capture"
import {
  createDictation,
  dictationPrompt,
  voiceReady,
  type DictationController,
} from "../../voice/dictation"
import { currentState } from "../selectors"
import { useWorkspaceServices, type WorkspaceServices } from "./context"
import { domEffects } from "./effects"

export const DictationContext = createContext<DictationController | undefined>(undefined)

// Dictation for this App, once, where its backend transcribes and can type into a
// terminal; undefined where it can't. A hold in progress ends with the App.
export const useDictationController = ({
  backend,
  workspace,
}: Pick<WorkspaceServices, "backend" | "workspace">): DictationController | undefined => {
  const { voice, typeInto } = backend
  const controller = useMemo(
    () =>
      voice &&
      typeInto &&
      createDictation({
        voice,
        typeInto,
        startCapture,
        promptFor: (key) => {
          const snapshot = workspace.getSnapshot()
          const terminal = tilesOf(currentState(snapshot).roster).find(
            (tile) => tile.id === key.terminalId,
          )
          const project = activeProject(snapshot)
          if (!terminal || !project) return undefined
          return dictationPrompt(project.name, "directory" in terminal ? terminal.directory : "")
        },
        now: domEffects.now,
        after: domEffects.after,
      }),
    [voice, typeInto, workspace],
  )
  useEffect(() => () => controller?.dictation.cancel(), [controller])
  return controller
}

const never = (): (() => void) => () => {}

// What a terminal's header needs for its mic button, or undefined where the button
// doesn't show: not an agent, or voice input off or without its model.
export const useMicButton = (
  terminal: TerminalMetadata,
  key: TerminalKey,
): { readonly recording: boolean; readonly onToggle: () => void } | undefined => {
  const { backend } = useWorkspaceServices()
  const controller = useContext(DictationContext)
  const state = useSyncExternalStore(
    backend.voice?.state.subscribe ?? never,
    () => backend.voice?.state.getSnapshot() ?? null,
  )
  const view = useSyncExternalStore(
    controller?.view.subscribe ?? never,
    () => controller?.view.getSnapshot() ?? null,
  )
  if (!controller || !state || !voiceReady(state) || !isAgentTerminal(terminal)) return undefined
  return {
    recording: view?.phase === "recording" && view.target?.terminalId === key.terminalId,
    onToggle: () => controller.dictation.toggle(key),
  }
}
