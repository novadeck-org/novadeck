import type { AgentStatus } from "../../model/types"
import { chatModeOn, chatReplyOf } from "../../terminals/chat/mode-state"
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

  context("when words are given back to the draft", () => {
    it("adds them after what was typed by then, in the session they were sent in", () => {
      const app = open({ working: false })
      app.commands.appendChatDraft("project/initial", "01", "use pnpm")
      expect(app.ui.getSnapshot().chatDrafts).toEqual({ "project/initial": { "01": "use pnpm" } })
      app.commands.setChatDraft("01", "meanwhile")
      app.commands.appendChatDraft("project/initial", "01", "use pnpm")
      expect(app.ui.getSnapshot().chatDrafts).toEqual({
        "project/initial": { "01": "meanwhile\nuse pnpm" },
      })
    })
  })

  context("when words come back to a draft holding a shell command", () => {
    it("puts them before it, so they never run as more of its lines", () => {
      const app = open({ working: false })
      app.commands.setChatDraft("01", "!npm test")
      app.commands.appendChatDraft("project/initial", "01", "also update the changelog")
      expect(app.ui.getSnapshot().chatDrafts).toEqual({
        "project/initial": { "01": "also update the changelog\n!npm test" },
      })
    })
  })

  context("when the agent whose question was being replied to ends", () => {
    it("holds the words written for it, or drops the reply where there are none", () => {
      const app = open({ working: false })
      const stop = watchChatModes(app.workspace, app.ui)
      app.commands.setChatDraft("01", "the second one")
      app.commands.setChatReply("project/initial", "01", { request: "r1", dialog: "d1" })
      app.status(undefined)
      app.status({ working: false })
      expect(chatReplyOf(app.ui.getSnapshot().chatReplies, "project/initial", "01")).toBe("held")
      app.commands.setChatDraft("01", "")
      app.commands.setChatReply("project/initial", "01", { request: "r2", dialog: "d2" })
      app.status(undefined)
      expect(chatReplyOf(app.ui.getSnapshot().chatReplies, "project/initial", "01")).toBeNull()
      stop()
    })
  })

  context("when a shell command went while words came back before it", () => {
    it("clears the command and keeps the words", () => {
      const app = open({ working: false })
      app.commands.setChatDraft("01", "also update the changelog\n!npm test")
      app.commands.clearChatDraft("project/initial", "01", "!npm test")
      expect(app.ui.getSnapshot().chatDrafts).toEqual({
        "project/initial": { "01": "also update the changelog" },
      })
    })
  })

  context("when the agent a reply was written for ends", () => {
    it("keeps the reply's hold with its words, for the next agent there, until the terminal closes", () => {
      const app = open({ working: false })
      const stop = watchChatModes(app.workspace, app.ui)
      app.commands.setChatDraft("01", "!important: pick X")
      app.commands.setChatReply("project/initial", "01", "held")
      app.status(undefined)
      app.status({ working: false })
      expect(chatReplyOf(app.ui.getSnapshot().chatReplies, "project/initial", "01")).toBe("held")
      app.workspace.dispatch({ type: "terminal/close", target, terminalId: "01" })
      expect(app.ui.getSnapshot().chatReplies).toEqual({})
      expect(app.ui.getSnapshot().chatDrafts).toEqual({})
      stop()
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

  context("when words were given back after a prompt's draft", () => {
    it("clears the prompt that was sent and keeps the words", () => {
      const app = open({ working: false })
      app.commands.setChatDraft("01", "go")
      app.commands.appendChatDraft("project/initial", "01", "use pnpm")
      app.commands.clearChatDraft("project/initial", "01", "go")
      expect(app.ui.getSnapshot().chatDrafts).toEqual({ "project/initial": { "01": "use pnpm" } })
    })

    it("does so though the sent prompt ended in spaces before them", () => {
      const app = open({ working: false })
      app.commands.setChatDraft("01", "go  \nuse pnpm")
      app.commands.clearChatDraft("project/initial", "01", "go")
      expect(app.ui.getSnapshot().chatDrafts).toEqual({ "project/initial": { "01": "use pnpm" } })
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
