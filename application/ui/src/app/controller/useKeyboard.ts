import { useEffect } from "react"

import {
  classifyKeyTarget,
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
import { createKeyCommands, keyState, runKey } from "../commands/keys"
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
  defaultPrevented: false,
  target: classifyKeyTarget(null),
}

// Routes window keyboard events through the keymap to the key commands: a capture
// and a bubble keydown listener, plus keyup and blur, all on window.
export const useKeyboard = (): void => {
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
    })
    const bindings = keymapFor(currentPlatform())
    const dispatch = (phase: KeyPhase, event: Event, input: KeyInput): void => {
      const candidates = routeKey(bindings, phase, input, keyState(services, commands), environment)
      if (runKey(keys, candidates, phase, input) !== "handled") return
      event.preventDefault()
      if (phase === "capture") event.stopPropagation()
    }
    const capture = (event: KeyboardEvent): void => dispatch("capture", event, keyInput(event))
    const bubble = (event: KeyboardEvent): void => dispatch("bubble", event, keyInput(event))
    const keyup = (event: KeyboardEvent): void => dispatch("keyup", event, keyInput(event))
    const blur = (event: FocusEvent): void => dispatch("blur", event, blurInput)
    window.addEventListener("keydown", capture, true)
    window.addEventListener("keydown", bubble)
    window.addEventListener("keyup", keyup)
    window.addEventListener("blur", blur)
    return () => {
      window.removeEventListener("keydown", capture, true)
      window.removeEventListener("keydown", bubble)
      window.removeEventListener("keyup", keyup)
      window.removeEventListener("blur", blur)
    }
  }, [services])
}
