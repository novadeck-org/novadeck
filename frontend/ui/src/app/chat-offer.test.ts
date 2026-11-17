import { readChatOfferAnswered } from "@novadeck/core/agents/chat-offer"
import { harnesses } from "@novadeck/core/harnesses"
import { workspaceFixture } from "@novadeck/core/testing"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import { afterEach } from "vitest"

import { readPreferences, preferencesStorageKey } from "../preferences/preferences-storage"
import { context, describe, expect, it } from "../test"
import { chatOfferDue, selectedAgentCanChat } from "./chat-offer"

afterEach(() => localStorage.clear())

// The fixture's workspace with its first terminal, the one it selects, made as `terminal` says.
const withSelected = (terminal: Partial<TerminalMetadata>): Workspace => {
  const workspace = workspaceFixture()
  const state = workspace.projects[0]!.history[0]!.state
  const [first, ...rest] = state.roster.terminals
  const roster = {
    ...state.roster,
    terminals: [{ ...first!, ...terminal } as TerminalMetadata, ...rest],
  }
  const history = [
    { ...workspace.projects[0]!.history[0]!, state: { ...state, roster, selected: first!.id } },
  ]
  return { ...workspace, projects: [{ ...workspace.projects[0]!, history }] }
}

const due = {
  reads: true,
  chatView: false,
  answered: false,
  held: false,
  welcome: false,
  canChat: true,
  touring: false,
}

describe("Agent Chat's offer", () => {
  context("what makes it due", () => {
    it("is due while the backend reads conversations, the chat view is off, it is unanswered and the selected terminal has a chat", () => {
      expect(chatOfferDue(due)).toBe(true)
    })

    it.each([
      ["the backend reads no conversations", { reads: false }],
      ["the chat view is already on", { chatView: true }],
      ["it was answered", { answered: true }],
      ["it is held back for this run", { held: true }],
      ["the welcome dialog is up", { welcome: true }],
      ["the selected terminal has no chat to show", { canChat: false }],
      ["the tour is running", { touring: true }],
    ])("is not due when %s", (_, change) => {
      expect(chatOfferDue({ ...due, ...change })).toBe(false)
    })
  })

  context("which selected terminals have a chat to show", () => {
    it.each(harnesses.map(({ id }) => id))(
      "counts a running %s agent, as the terminal's chat does",
      (id) => {
        expect(selectedAgentCanChat(withSelected({ state: "running", process: id }))).toBe(true)
        expect(
          selectedAgentCanChat(
            withSelected({ state: "running", process: "zsh", agent: { working: false } }),
          ),
        ).toBe(true)
      },
    )

    it("does not count a shell, or an agent that has ended", () => {
      expect(selectedAgentCanChat(withSelected({ state: "running", process: "zsh" }))).toBe(false)
      expect(selectedAgentCanChat(withSelected({ state: "idle", process: "claude" }))).toBe(false)
    })
  })

  context("for someone who updated from before the offer", () => {
    it("is due, as their saved preferences and storage hold no note of it", () => {
      localStorage.setItem(
        preferencesStorageKey,
        JSON.stringify({ fontSize: 15, enabledViews: ["focus"], notifyNeeds: false }),
      )
      expect(
        chatOfferDue({
          ...due,
          chatView: readPreferences().chatView,
          answered: readChatOfferAnswered(),
        }),
      ).toBe(true)
    })
  })
})
