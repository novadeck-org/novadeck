import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react"

import type { TerminalKey } from "../../backend/port"
import type { TerminalMetadata } from "../../model/types"
import { chatDraftOf, chatShown, setChatDraft } from "../../terminals/chat/mode-state"
import type { DictationControls } from "../../terminals/WindowShell"
import { isAgentTerminal } from "../../voice/agent-terminal"
import { startCapture } from "../../voice/capture"
import {
  createDictation,
  dictationKey,
  voiceReady,
  type DictationController,
} from "../../voice/dictation"
import type { UiStore } from "../ui-store"
import { useWorkspaceServices, type WorkspaceServices } from "./context"
import { domEffects } from "./effects"

export const DictationContext = createContext<DictationController | undefined>(undefined)

// Where dictated words go: a terminal showing its agent's chat takes them in the chat's box,
// after what is there, for the person to send; any other takes them typed into it.
// `terminalOf` finds the terminal a key names, on a backend that reads conversations.
export const dictateInto =
  (
    ui: UiStore,
    typeInto: (key: TerminalKey, text: string) => boolean,
    terminalOf: (key: TerminalKey) => TerminalMetadata | undefined,
  ) =>
  (key: TerminalKey, text: string): boolean => {
    const context = `${key.projectId}/${key.workspaceSessionId}`
    const terminal = terminalOf(key)
    const { preferences, answering } = ui.getSnapshot()
    if (!terminal || !chatShown(preferences.chatView, answering, context, terminal))
      return typeInto(key, text)
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
        typeInto: dictateInto(ui, typeInto, (key) =>
          backend.conversations
            ? workspace
                .getSnapshot()
                .projects.find((project) => project.id === key.projectId)
                ?.history.find((session) => session.id === key.workspaceSessionId)
                ?.state.roster.terminals.find((each) => each.id === key.terminalId)
            : undefined,
        ),
        startCapture,
        now: domEffects.now,
        after: domEffects.after,
      }),
    [voice, typeInto, backend.conversations, workspace, ui],
  )
  useEffect(() => () => controller?.dictation.cancel(), [controller])
  return controller
}

const never = (): (() => void) => () => {}

// What a terminal's header needs for its mic button, or undefined where the button
// doesn't show: not an agent, no voice input on this machine, or the person turned it
// off. Until voice input is ready the button opens Addons, where it is installed.
export const useMicButton = (
  terminal: TerminalMetadata,
  key: TerminalKey,
): DictationControls | undefined => {
  const { backend, navigation } = useWorkspaceServices()
  const controller = useContext(DictationContext)
  const state = useSyncExternalStore(
    backend.voice?.state.subscribe ?? never,
    () => backend.voice?.state.getSnapshot() ?? null,
  )
  const view = useSyncExternalStore(
    controller?.view.subscribe ?? never,
    () => controller?.view.getSnapshot() ?? null,
  )
  if (!controller || !state || !state.available || !state.wanted || !isAgentTerminal(terminal))
    return undefined
  if (!voiceReady(state))
    return {
      recording: false,
      ready: false,
      onToggle: () => navigation.go({ dialog: "preferences", section: "addons" }),
    }
  return {
    recording:
      view?.phase === "recording" &&
      view.target !== null &&
      dictationKey(view.target) === dictationKey(key),
    onToggle: () => controller.dictation.toggle(key),
  }
}
