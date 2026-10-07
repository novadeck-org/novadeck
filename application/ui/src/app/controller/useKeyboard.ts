import { useEffect } from "react"

import {
  classifyKeyTarget,
  insideOwnKeys,
  navigateHome,
  terminalTabInteractionActive,
  workspaceOverlayOpen,
} from "../../interaction/dom"
import {
  keymapFor,
  routeKey,
  type KeyEnvironment,
  type KeyInput,
  type KeyPhase,
} from "../../interaction/keymap"
import { currentPlatform } from "../../interaction/shortcuts"
import type { Dictation } from "../../voice/dictation-control"
import { createKeyCommands, keyState, runKey } from "../commands/keys"
import { currentState } from "../selectors"
import { useWorkspaceServices } from "./context"
import { domEffects } from "./effects"

const environment: KeyEnvironment = {
  overlayOpen: workspaceOverlayOpen,
  tabInteraction: terminalTabInteractionActive,
}

const keyInput = (event: KeyboardEvent): KeyInput => ({
  key: event.key,
  code: event.code,
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
  shiftKey: event.shiftKey,
  altKey: event.altKey,
  repeat: event.repeat,
  composing: event.isComposing || event.keyCode === 229,
  altGraph: event.getModifierState("AltGraph"),
  defaultPrevented: event.defaultPrevented,
  target: classifyKeyTarget(event.target),
})

// Blur carries no key; only the release layer listens for it.
const blurInput: KeyInput = {
  key: "",
  code: "",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  repeat: false,
  composing: false,
  altGraph: false,
  defaultPrevented: false,
  target: classifyKeyTarget(null),
}

// Routes window keyboard events through the keymap to the key commands: a capture
// and a bubble keydown listener, plus keyup and blur, all on window. It also keeps the
// keyboard's home in the selected terminal: navigating ends once focus moves into a
// field or a terminal, or the mouse goes down, and a mouse click on the workspace's
// chrome hands typing back to the selected terminal. `dictation` is the backend's voice
// input, if it has one.
export const useKeyboard = (dictation?: Dictation): void => {
  const services = useWorkspaceServices()
  useEffect(() => {
    const { ui, workspace, navigation, commands, canvas, backend } = services
    const keys = createKeyCommands(commands, {
      workspace,
      ui,
      navigation,
      newTerminal: backend.newTerminal,
      canvas,
      effects: domEffects,
      dictation,
    })
    const bindings = keymapFor(currentPlatform())
    const dispatch = (phase: KeyPhase, event: Event, input: KeyInput): void => {
      const candidates = routeKey(
        bindings,
        phase,
        input,
        keyState({ ...services, dictation }, commands),
        environment,
      )
      if (runKey(keys, candidates, phase, input) !== "handled") return
      event.preventDefault()
      if (phase === "capture") event.stopPropagation()
    }
    const capture = (event: KeyboardEvent): void => dispatch("capture", event, keyInput(event))
    const bubble = (event: KeyboardEvent): void => dispatch("bubble", event, keyInput(event))
    const keyup = (event: KeyboardEvent): void => dispatch("keyup", event, keyInput(event))
    const blur = (event: FocusEvent): void => dispatch("blur", event, blurInput)
    // Navigating holds only while focus is on a view or a Canvas node: a control reached
    // with Tab keeps its own Enter.
    const focusin = (event: FocusEvent): void => {
      if (!navigateHome(event.target)) commands.setNavigate(false)
    }
    const pointerdown = (): void => commands.setNavigate(false)
    // Only a mouse: a tap that focused a terminal would raise a phone's keyboard. A click
    // whose control moves focus itself, as Zen's do, keeps where it put it, and one in a
    // region that takes its own keys leaves focus to it, even off its controls.
    const click = (event: MouseEvent): void => {
      if (!(event instanceof PointerEvent) || event.pointerType !== "mouse") return
      const clicked = document.activeElement
      const on = classifyKeyTarget(event.target)
      // A chat holds text to select and controls that keep the focus they take.
      if (on.companion || on.zenDock || on.chat || insideOwnKeys(event.target)) return
      if (window.getSelection()?.isCollapsed === false) return
      requestAnimationFrame(() => {
        const now = document.activeElement
        if (now !== clicked && now !== document.body) return
        const target = classifyKeyTarget(now)
        if (target.editing || target.companion || target.zenDock || target.chat) return
        if (keyState({ ...services, dictation }, commands).dialog || environment.overlayOpen())
          return
        if (environment.tabInteraction() || ui.getSnapshot().shell.navigate) return
        const { selected, view } = currentState(workspace.getSnapshot())
        if (selected) commands.setKeyboardFocus({ id: selected, view })
      })
    }
    window.addEventListener("keydown", capture, true)
    window.addEventListener("keydown", bubble)
    window.addEventListener("keyup", keyup)
    window.addEventListener("blur", blur)
    window.addEventListener("focusin", focusin)
    window.addEventListener("pointerdown", pointerdown, true)
    window.addEventListener("click", click)
    return () => {
      window.removeEventListener("keydown", capture, true)
      window.removeEventListener("keydown", bubble)
      window.removeEventListener("keyup", keyup)
      window.removeEventListener("blur", blur)
      window.removeEventListener("focusin", focusin)
      window.removeEventListener("pointerdown", pointerdown, true)
      window.removeEventListener("click", click)
    }
  }, [services, dictation])
}
