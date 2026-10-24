import { chatDraftOf, createChat, setChatDraft } from "@novadeck/chat/state"
import type { TerminalKey } from "@novadeck/core/port"
import { createWorkspaceStore } from "@novadeck/core/store"
import { createStore } from "@novadeck/core/store"
import { workspaceFixture } from "@novadeck/core/testing"
import { appearance } from "@novadeck/core/testing"
import type { TerminalMetadata } from "@novadeck/core/types"
import { vi } from "vitest"

import { describe, expect, it } from "../../test"
import type { VoiceSetup } from "../../voice/dictation"
import { createUiStore, initialUi, type UiStore } from "../ui-store"
import { watchOfferDismissal, dictateInto } from "./dictation"

const key: TerminalKey = { projectId: "project", workspaceSessionId: "initial", terminalId: "01" }
const context = "project/initial"
const agent: TerminalMetadata = {
  id: "01",
  name: "Terminal",
  directory: "/",
  command: "zsh",
  process: "claude",
  state: "running",
  agent: { working: false },
}
const terminalOf = (): TerminalMetadata => agent

const ui = (): UiStore =>
  createUiStore(
    initialUi({
      location: {
        route: {
          projectId: "project",
          sessionId: "initial",
          view: "focus",
          terminal: "",
          panel: "terminals",
          dialog: null,
          section: "general",
        },
        dialogDepth: 0,
        navigationType: "POP",
      },
      preferences: {
        fontSize: 13,
        enabledViews: ["focus"],
        appearance,
        notifyNeeds: true,
        notifyFinished: true,
        ligatures: false,
        chatView: false,
      },
    }),
  )

const chatOn = (store: UiStore): void => {
  store.update((state) => ({ ...state, preferences: { ...state.preferences, chatView: true } }))
}

describe("dictated words", () => {
  it("are typed into a terminal showing its screen", () => {
    const store = ui()
    const chat = createChat()
    const typeInto = vi.fn<(key: TerminalKey, text: string) => boolean>(() => true)
    expect(dictateInto(store, chat, typeInto, terminalOf)(key, "run the tests")).toBe(true)
    expect(typeInto).toHaveBeenCalledWith(key, "run the tests")
    expect(chatDraftOf(chat.store.getSnapshot().drafts, context, "01")).toBe("")
  })

  it("go into the chat's box after what is there, where the terminal shows its chat", () => {
    const store = ui()
    const chat = createChat()
    chatOn(store)
    chat.update((state) => ({
      ...state,
      drafts: setChatDraft(state.drafts, context, "01", "Please"),
    }))
    const typeInto = vi.fn<(key: TerminalKey, text: string) => boolean>(() => true)
    expect(dictateInto(store, chat, typeInto, terminalOf)(key, "run the tests")).toBe(true)
    expect(typeInto).not.toHaveBeenCalled()
    expect(chatDraftOf(chat.store.getSnapshot().drafts, context, "01")).toBe("Please run the tests")
  })
})

describe("an offer that is ignored", () => {
  const target = { projectId: "project", workspaceSessionId: "initial" }
  const offered = (at: TerminalKey) => {
    const workspace = createWorkspaceStore(workspaceFixture())
    workspace.dispatch({ type: "terminal/select", target, terminalId: "01" })
    const setup = createStore<VoiceSetup | null>({ kind: "offer", target: at })
    const dismiss = vi.fn<() => void>()
    const stop = watchOfferDismissal(
      { setup, setupActions: { turnOn() {}, noThanks() {}, cancel() {}, dismiss } },
      workspace,
    )
    // A key aimed at `on`, as the browser sends it through the window's capture phase.
    const press = (init: KeyboardEventInit, on: Element = document.body): void => {
      on.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }))
    }
    return { workspace, dismiss, press, stop }
  }

  it("goes once the person types into the terminal", () => {
    const { dismiss, press, stop } = offered(key)
    press({ key: "x" })
    expect(dismiss).toHaveBeenCalledTimes(1)
    stop()
  })

  it("takes Tab in a terminal as typing, and Tab elsewhere as a move toward the offer", () => {
    const { dismiss, press, stop } = offered(key)
    const terminal = document.createElement("div")
    terminal.className = "xterm"
    const input = document.createElement("textarea")
    terminal.append(input)
    document.body.append(terminal)
    press({ key: "Tab" })
    expect(dismiss).not.toHaveBeenCalled()
    press({ key: "Tab" }, input)
    expect(dismiss).toHaveBeenCalledTimes(1)
    terminal.remove()
    stop()
  })

  it("stays for modifiers and the shortcut itself", () => {
    const { dismiss, press, stop } = offered(key)
    press({ key: "Shift" })
    press({ key: "M", ctrlKey: true, shiftKey: true })
    expect(dismiss).not.toHaveBeenCalled()
    stop()
  })

  it("stays for keys aimed at its own buttons, so Enter and Space answer it", () => {
    const { dismiss, press, stop } = offered(key)
    const strip = document.createElement("div")
    strip.className = "dictation-strip"
    const button = document.createElement("button")
    strip.append(button)
    document.body.append(strip)
    press({ key: "Enter" }, button)
    press({ key: " " }, button)
    expect(dismiss).not.toHaveBeenCalled()
    press({ key: "Enter" })
    expect(dismiss).toHaveBeenCalledTimes(1)
    strip.remove()
    stop()
  })

  it("goes when another terminal is selected, but not for the one it was made on", () => {
    const { workspace, dismiss, stop } = offered({ ...key, terminalId: "02" })
    workspace.dispatch({ type: "terminal/select", target, terminalId: "02" })
    expect(dismiss).not.toHaveBeenCalled()
    workspace.dispatch({ type: "terminal/select", target, terminalId: "01" })
    expect(dismiss).toHaveBeenCalledTimes(1)
    stop()
  })
})
