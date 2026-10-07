import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react"

import type { TerminalKey } from "../../backend/port"
import { tilesOf } from "../../model/roster"
import { activeProject } from "../../model/state"
import type { TerminalMetadata } from "../../model/types"
import { chatDraftOf, chatModeOn, setChatDraft } from "../../terminals/chat/mode-state"
import { isAgentTerminal } from "../../voice/agent-terminal"
import { startCapture } from "../../voice/capture"
import {
  createDictation,
  dictationPrompt,
  voiceReady,
  type DictationController,
} from "../../voice/dictation"
import { currentState } from "../selectors"
import type { UiStore } from "../ui-store"
import { useWorkspaceServices, type WorkspaceServices } from "./context"
import { domEffects } from "./effects"

export const DictationContext = createContext<DictationController | undefined>(undefined)

// Where dictated words go: a terminal showing its agent's chat takes them in the chat's box,
// after what is there, for the person to send; any other takes them typed into it.
export const dictateInto =
  (ui: UiStore, typeInto: (key: TerminalKey, text: string) => boolean) =>
  (key: TerminalKey, text: string): boolean => {
    const context = `${key.projectId}/${key.workspaceSessionId}`
    if (!chatModeOn(ui.getSnapshot().chat, context, key.terminalId)) return typeInto(key, text)
    ui.update((state) => {
      const draft = chatDraftOf(state.chatDrafts, context, key.terminalId)
      const next =
        draft.trim() === "" ? text : /\s$/.test(draft) ? draft + text : `${draft} ${text}`
      return {
        ...state,
        chatDrafts: setChatDraft(state.chatDrafts, context, key.terminalId, next),
      }
    })
    return true
  }

// Dictation for this App, once, where its backend transcribes and can type into a
// terminal; undefined where it can't. A hold in progress ends with the App.
export const useDictationController = ({
  backend,
  workspace,
  ui,
}: Pick<WorkspaceServices, "backend" | "workspace" | "ui">): DictationController | undefined => {
  const { voice, typeInto } = backend
  const controller = useMemo(
    () =>
      voice &&
      typeInto &&
      createDictation({
        voice,
        typeInto: dictateInto(ui, typeInto),
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
    [voice, typeInto, workspace, ui],
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
