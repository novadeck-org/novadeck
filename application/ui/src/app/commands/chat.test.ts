import type { AgentStatus } from "../../model/types"
import { chatModeOn } from "../../terminals/chat/mode-state"
import { context, describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"
import { watchChatModes } from "../ui-store"

const target = { projectId: "project", workspaceSessionId: "initial" }

const open = (agent?: AgentStatus) => {
  const app = openCommands()
  const status = (next: AgentStatus | undefined) =>
    app.workspace.dispatch({
      type: "terminal/status",
      target,
      terminalId: "01",
      status: next ? { state: "running", agent: next } : { state: "idle" },
    })
  status(agent)
  return {
    ...app,
    status,
    on: () => chatModeOn(app.ui.getSnapshot().chat, "project/initial", "01"),
  }
}

describe("chat commands", () => {
  context("when toggling a terminal whose agent runs", () => {
    it("shows its chat, then its screen, each time moving typing there", () => {
      const app = open({ working: false })
      app.commands.toggleChat("01")
      expect(app.on()).toBe(true)
      expect(app.shell().keyboardFocus).toEqual({ id: "01", view: "grid" })
      app.commands.toggleChat("01")
      expect(app.on()).toBe(false)
    })

    it("selects the terminal", () => {
      const app = open({ working: false })
      app.commands.setSelected("02")
      app.commands.toggleChat("01")
      expect(app.urls.at(-1)).toContain("terminal=01")
    })

    it("shows its screen to answer in the terminal", () => {
      const app = open({ working: false })
      app.commands.toggleChat("01")
      app.commands.showTerminal("01")
      expect(app.on()).toBe(false)
      expect(app.shell().keyboardFocus).toEqual({ id: "01", view: "grid" })
    })
  })

  context("for a terminal without an agent", () => {
    it("has no chat to show", () => {
      const app = open()
      app.commands.toggleChat("01")
      expect(app.on()).toBe(false)
      expect(app.shell().keyboardFocus).toBeNull()
    })

    it("has none for a terminal that isn't there", () => {
      const app = open({ working: false })
      app.commands.toggleChat("missing")
      expect(app.ui.getSnapshot().chat).toEqual({})
    })
  })

  context("when typing a draft", () => {
    it("keeps it for the terminal past its agent's end, for the next agent there, until it closes", () => {
      const app = open({ working: false })
      const stop = watchChatModes(app.workspace, app.ui)
      app.commands.setChatDraft("01", "hello")
      expect(app.ui.getSnapshot().chatDrafts).toEqual({ "project/initial": { "01": "hello" } })
      app.status(undefined)
      expect(app.ui.getSnapshot().chatDrafts).toEqual({ "project/initial": { "01": "hello" } })
      app.workspace.dispatch({ type: "terminal/close", target, terminalId: "01" })
      expect(app.ui.getSnapshot().chatDrafts).toEqual({})
      stop()
    })
  })

  context("when words come back to the draft", () => {
    it("adds them on a line of their own after what is there", () => {
      const app = open({ working: false })
      app.commands.appendChatDraft("project/initial", "01", "Queued beta")
      expect(app.ui.getSnapshot().chatDrafts).toEqual({
        "project/initial": { "01": "Queued beta" },
      })
      app.commands.setChatDraft("01", "typed")
      app.commands.appendChatDraft("project/initial", "01", "Queued beta")
      expect(app.ui.getSnapshot().chatDrafts).toEqual({
        "project/initial": { "01": "typed\nQueued beta" },
      })
    })
  })

  context("when a sent prompt's draft is cleared", () => {
    it("clears it where it was sent, unless it has changed since", () => {
      const app = open({ working: false })
      app.commands.setChatDraft("01", "go")
      app.commands.clearChatDraft("project/initial", "01", "go")
      expect(app.ui.getSnapshot().chatDrafts).toEqual({})
      app.commands.setChatDraft("01", "going")
      app.commands.clearChatDraft("project/initial", "01", "go")
      expect(app.ui.getSnapshot().chatDrafts).toEqual({ "project/initial": { "01": "going" } })
    })

    it("keeps words dictated after it while it went, without the sent prompt", () => {
      const app = open({ working: false })
      app.commands.setChatDraft("01", "Fix the login bug and add a test")
      app.commands.clearChatDraft("project/initial", "01", "Fix the login bug")
      expect(app.ui.getSnapshot().chatDrafts).toEqual({
        "project/initial": { "01": "and add a test" },
      })
    })
  })

  context("when the agent ends", () => {
    it("shows the terminal again, and a later agent starts on its screen", () => {
      const app = open({ working: false })
      const stop = watchChatModes(app.workspace, app.ui)
      app.commands.toggleChat("01")
      expect(app.on()).toBe(true)
      app.status(undefined)
      expect(app.on()).toBe(false)
      app.status({ working: true })
      expect(app.on()).toBe(false)
      stop()
    })

    it("keeps the chat through a restart, and drops it once the terminal settles elsewhere", () => {
      const app = open({ working: false })
      const stop = watchChatModes(app.workspace, app.ui)
      app.commands.toggleChat("01")
      app.commands.setChatDraft("01", "draft")
      app.workspace.dispatch({
        type: "terminal/status",
        target,
        terminalId: "01",
        status: { state: "starting" },
      })
      expect(app.on()).toBe(true)
      expect(app.ui.getSnapshot().chatDrafts).not.toEqual({})
      app.status({ working: false })
      expect(app.on()).toBe(true)
      app.workspace.dispatch({
        type: "terminal/status",
        target,
        terminalId: "01",
        status: { state: "exited", exitCode: 0, signal: null },
      })
      expect(app.on()).toBe(false)
      // The words typed stay, for whatever runs there next.
      expect(app.ui.getSnapshot().chatDrafts).toEqual({ "project/initial": { "01": "draft" } })
      stop()
    })

    it("keeps the chat while the agent runs on", () => {
      const app = open({ working: false })
      const stop = watchChatModes(app.workspace, app.ui)
      app.commands.toggleChat("01")
      app.status({ working: true })
      expect(app.on()).toBe(true)
      stop()
    })
  })
})
