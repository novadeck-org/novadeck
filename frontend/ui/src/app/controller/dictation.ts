import { chatShown, dictateIntoDraft, type Chat } from "@novadeck/chat/state"
import type { TerminalKey } from "@novadeck/core/port"
import type { WorkspaceStore } from "@novadeck/core/store"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react"

import { currentPlatform, matchesShortcut, shortcutBindings } from "../../interaction/shortcuts"
import type { DictationControls } from "../../terminals/WindowShell"
import { isAgentTerminal } from "../../voice/agent-terminal"
import { startCapture } from "../../voice/capture"
import {
  createDictation,
  dictationKey,
  voiceClaimed,
  voiceReady,
  type DictationController,
} from "../../voice/dictation"
import { currentContext, currentState } from "../selectors"
import { chatViewOn, type UiStore } from "../ui-store"
import { useWorkspaceServices, type WorkspaceServices } from "./context"
import { domEffects } from "./effects"

export const DictationContext = createContext<DictationController | undefined>(undefined)

// Where dictated words go: a terminal showing its agent's chat takes them in the chat's box,
// after what is there, for the person to send; any other takes them typed into it.
// `terminalOf` finds the terminal a key names, on a backend that reads conversations.
export const dictateInto =
  (
    ui: UiStore,
    chat: Chat,
    typeInto: (key: TerminalKey, text: string) => boolean,
    terminalOf: (key: TerminalKey) => TerminalMetadata | undefined,
  ) =>
  (key: TerminalKey, text: string): boolean => {
    const context = `${key.projectId}/${key.workspaceSessionId}`
    const terminal = terminalOf(key)
    const { answering } = chat.store.getSnapshot()
    if (!terminal || !chatShown(chatViewOn(ui.getSnapshot()), answering, context, terminal))
      return typeInto(key, text)
    dictateIntoDraft(chat, context, key.terminalId, text)
    return true
  }

// The terminal the person is at, whose change ends an offer made there.
const placeOf = (snapshot: Workspace): string =>
  `${currentContext(snapshot)}/${currentState(snapshot).selected}`

// Ends an offer that is ignored: once the person types into the terminal, or goes to another
// one. Keys aimed at voice input's own strip or pill (Tab, Enter or Space on its buttons) are
// the person answering it, and Tab from outside a terminal only moves toward it. A terminal
// takes Tab as its own key (a shell's completion), so there it is typing. The keyboard's way
// to answer is the shortcut again, which turns voice input on; ignoring the offer is the
// keyboard's no. Returns what stops watching.
export const watchOfferDismissal = (
  controller: Pick<DictationController, "setup" | "setupActions">,
  workspace: Pick<WorkspaceStore, "getSnapshot" | "subscribe">,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): (() => void) => {
  const typed = (event: KeyboardEvent): void => {
    const modifier = ["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(event.key)
    // The shortcut itself, pressed again, turns voice input on.
    const chord = matchesShortcut(event, shortcutBindings(currentPlatform()).voice)
    const at = event.target instanceof Element ? event.target : null
    const within = at?.closest(".dictation-strip, .dictation-overlay") != null
    const typing =
      event.key === "Tab" ? at?.closest(".xterm, [data-terminal-input]") != null : !modifier
    if (typing && !chord && !within) controller.setupActions.dismiss()
  }
  let place = placeOf(workspace.getSnapshot())
  const stopWorkspace = workspace.subscribe(() => {
    const next = placeOf(workspace.getSnapshot())
    if (next === place) return
    place = next
    // Going to the terminal the offer was made on, as clicking its mic selects it, is
    // not leaving it.
    const offer = controller.setup.getSnapshot()?.target
    if (offer && next === `${offer.projectId}/${offer.workspaceSessionId}/${offer.terminalId}`)
      return
    controller.setupActions.dismiss()
  })
  target.addEventListener("keydown", typed as EventListener, true)
  return () => {
    target.removeEventListener("keydown", typed as EventListener, true)
    stopWorkspace()
  }
}

// Dictation for this App, once, where its backend transcribes and can type into a
// terminal; undefined where it can't. A hold in progress ends with the App.
export const useDictationController = ({
  backend,
  workspace,
  ui,
  chat,
  commands,
}: Pick<WorkspaceServices, "backend" | "workspace" | "ui" | "chat" | "commands">):
  | DictationController
  | undefined => {
  const { voice, typeInto } = backend
  const controller = useMemo(
    () =>
      voice &&
      typeInto &&
      createDictation({
        voice,
        offered: () => void commands.takeAddonOffer("voice"),
        typeInto: dictateInto(ui, chat, typeInto, (key) =>
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
    [voice, typeInto, backend.conversations, workspace, ui, chat, commands],
  )
  useEffect(() => () => controller?.dictation.cancel(), [controller])
  useEffect(() => controller?.start(), [controller])
  useEffect(
    () => (controller ? watchOfferDismissal(controller, workspace) : undefined),
    [controller, workspace],
  )
  return controller
}

const never = (): (() => void) => () => {}

// What a terminal's header needs for its mic button, or undefined where the button
// doesn't show: not an agent, no voice input on this machine, or the person turned it
// off or said no thanks. Until voice input is ready the button offers to install it.
export const useMicButton = (
  terminal: TerminalMetadata,
  key: TerminalKey,
): DictationControls | undefined => {
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
  if (!controller || !state || !voiceClaimed(state) || !isAgentTerminal(terminal)) return undefined
  if (!voiceReady(state))
    return { recording: false, ready: false, onToggle: () => controller.dictation.toggle(key) }
  return {
    recording:
      view?.phase === "recording" &&
      view.target !== null &&
      dictationKey(view.target) === dictationKey(key),
    onToggle: () => controller.dictation.toggle(key),
  }
}
