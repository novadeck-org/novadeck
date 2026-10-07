import { vi } from "vitest"

import type { TerminalKey } from "../../backend/port"
import { chatDraftOf, setChatDraft, setChatMode } from "../../terminals/chat/mode-state"
import { describe, expect, it } from "../../test"
import { appearance } from "../../test/fixtures"
import { createUiStore, initialUi, type UiStore } from "../ui-store"
import { dictateInto } from "./dictation"

const key: TerminalKey = { projectId: "project", workspaceSessionId: "initial", terminalId: "01" }
const context = "project/initial"

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
        notifyFinished: true,
        ligatures: false,
      },
    }),
  )

describe("dictated words", () => {
  it("are typed into a terminal showing its screen", () => {
    const store = ui()
    const typeInto = vi.fn<(key: TerminalKey, text: string) => boolean>(() => true)
    expect(dictateInto(store, typeInto)(key, "run the tests")).toBe(true)
    expect(typeInto).toHaveBeenCalledWith(key, "run the tests")
    expect(chatDraftOf(store.getSnapshot().chatDrafts, context, "01")).toBe("")
  })

  it("go into the chat's box after what is there, where the terminal shows its chat", () => {
    const store = ui()
    store.update((state) => ({
      ...state,
      chat: setChatMode(state.chat, context, "01", true),
      chatDrafts: setChatDraft(state.chatDrafts, context, "01", "Please"),
    }))
    const typeInto = vi.fn<(key: TerminalKey, text: string) => boolean>(() => true)
    expect(dictateInto(store, typeInto)(key, "run the tests")).toBe(true)
    expect(typeInto).not.toHaveBeenCalled()
    expect(chatDraftOf(store.getSnapshot().chatDrafts, context, "01")).toBe("Please run the tests")
  })
})
