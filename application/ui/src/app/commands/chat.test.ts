import { noConversation, type Conversations } from "../../model/conversation"
import type { AgentStatus } from "../../model/types"
import { chatDraftOf, chatReplyOf, chatSendOf, chatShown } from "../../terminals/chat/mode-state"
import { context, describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"
import { watchChatModes } from "../ui-store"

const target = { projectId: "project", workspaceSessionId: "initial" }

const waiting: AgentStatus = { working: true, attention: { kind: "permission", count: 1 } }

const open = (agent?: AgentStatus, conversations?: Conversations, chatView = true) => {
  const app = openCommands({ conversations })
  app.ui.update((state) => ({ ...state, preferences: { ...state.preferences, chatView } }))
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
    on: () => {
      const { preferences, answering } = app.ui.getSnapshot()
      const terminal = app.workspace
        .getSnapshot()
        .projects[0]!.history[0]!.state.roster.terminals.find((each) => each.id === "01")!
      return chatShown(preferences.chatView, answering, "project/initial", terminal)
    },
  }
}

describe("chat commands", () => {
  context("with the chat view on", () => {
    it("shows the chat of a terminal whose agent runs, and none for one without", () => {
      expect(open({ working: false }).on()).toBe(true)
      expect(open().on()).toBe(false)
    })

    it("shows its screen to answer in the terminal, selecting it and moving typing there", () => {
      const app = open(waiting)
      app.commands.setSelected("02")
      app.commands.showTerminal("01")
      expect(app.on()).toBe(false)
      expect(app.urls.at(-1)).toContain("terminal=01")
      expect(app.shell().keyboardFocus).toEqual({ id: "01", view: "grid" })
    })

    it("shows the chat again once the agent no longer waits on the person", () => {
      const app = open(waiting)
      const stop = watchChatModes(app.workspace, app.ui)
      app.commands.showTerminal("01")
      app.status({ ...waiting })
      expect(app.on()).toBe(false)
      app.status({ working: true })
      expect(app.on()).toBe(true)
      stop()
    })

    it("has nothing to answer in a terminal that isn't there", () => {
      const app = open({ working: false })
      app.commands.showTerminal("missing")
      expect(app.ui.getSnapshot().answering).toEqual({})
    })

    it("shows every chat afresh once the chat view is turned off and on again", () => {
      const app = open(waiting)
      app.commands.showTerminal("01")
      const { preferences } = app.ui.getSnapshot()
      app.commands.updatePreferences({ ...preferences, chatView: false })
      expect(app.on()).toBe(false)
      app.commands.updatePreferences({ ...preferences, chatView: true })
      expect(app.on()).toBe(true)
    })
  })

  context("with the chat view off", () => {
    it("shows no chat", () => {
      expect(open({ working: false }, undefined, false).on()).toBe(false)
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

  context("when the draft is sent", () => {
    const key = { ...target, terminalId: "01" }
    const sending = () => {
      const settle: { resolve: () => void; reject: (failure: unknown) => void }[] = []
      const sent: string[] = []
      const answers: unknown[] = []
      const wait = () => new Promise<void>((resolve, reject) => settle.push({ resolve, reject }))
      const app = open(
        { working: false },
        {
          conversation: () => ({ getSnapshot: () => noConversation, subscribe: () => () => {} }),
          send: (_key, text) => (sent.push(text), wait()),
          interrupt: async () => null,
          answer: (_key, request, answer) => (answers.push([request, answer]), wait()),
          refused: () => false,
        },
      )
      const draft = () => chatDraftOf(app.ui.getSnapshot().chatDrafts, "project/initial", "01")
      const inFlight = () => chatSendOf(app.ui.getSnapshot().chatSends, "project/initial", "01")
      return { app, settle, sent, answers, draft, inFlight }
    }

    it("takes the words out of the draft as they go, and keeps none once they arrive", async () => {
      const { app, settle, sent, draft, inFlight } = sending()
      app.commands.setChatDraft("01", "go")
      const going = app.commands.sendChat(key, "go", null)
      expect(draft()).toBe("")
      expect(inFlight()).toEqual({ draft: "go", to: null })
      app.commands.setChatDraft("01", "next")
      settle[0]!.resolve()
      await going
      expect(sent).toEqual(["go"])
      expect(inFlight()).toBeNull()
      expect(draft()).toBe("next")
    })

    it("puts them back before what was typed meanwhile when they don't arrive", async () => {
      const { app, settle, draft, inFlight } = sending()
      app.commands.setChatDraft("01", "go")
      const going = app.commands.sendChat(key, "go", null)
      app.commands.appendChatDraft("project/initial", "01", "use pnpm")
      settle[0]!.reject(new Error("The runner is offline."))
      await expect(going).rejects.toThrow("The runner is offline.")
      expect(draft()).toBe("go\nuse pnpm")
      expect(inFlight()).toBeNull()
    })

    it("puts a shell command back after words that came meanwhile, so they never run as its lines", async () => {
      const { app, settle, draft } = sending()
      const going = app.commands.sendChat(key, "!npm test", null)
      app.commands.setChatDraft("01", "also update the changelog")
      settle[0]!.reject(new Error("no"))
      await expect(going).rejects.toThrow()
      expect(draft()).toBe("also update the changelog\n!npm test")
    })

    it("puts back the draft as it was typed, not the words as sent", async () => {
      const { app, settle, draft } = sending()
      app.commands.setChatDraft("01", "  go\n")
      const going = app.commands.sendChat(key, "go", null)
      settle[0]!.reject(new Error("no"))
      await expect(going).rejects.toThrow()
      expect(draft()).toBe("  go\n")
    })

    it("joins a shell command that didn't go and one typed meanwhile into one to look over", async () => {
      const { app, settle, draft } = sending()
      const going = app.commands.sendChat(key, "!npm test", null)
      app.commands.setChatDraft("01", "!ls")
      settle[0]!.reject(new Error("no"))
      await expect(going).rejects.toThrow()
      expect(draft()).toBe("!npm test\nls")
    })

    it("puts nothing back for a terminal that closed meanwhile", async () => {
      const { app, settle, inFlight } = sending()
      const going = app.commands.sendChat(key, "go", null)
      app.workspace.dispatch({ type: "terminal/close", target, terminalId: "01" })
      settle[0]!.reject(new Error("no"))
      await expect(going).rejects.toThrow()
      expect(app.ui.getSnapshot().chatDrafts).toEqual({})
      expect(inFlight()).toBeNull()
    })

    it("sends one at a time", async () => {
      const { app, settle, sent } = sending()
      const first = app.commands.sendChat(key, "one", null)
      await expect(app.commands.sendChat(key, "two", null)).rejects.toThrow("still on its way")
      settle[0]!.resolve()
      await first
      expect(sent).toEqual(["one"])
    })

    it("answers the question a reply names on one line, and ends the reply once it took", async () => {
      const { app, settle, answers } = sending()
      const to = { request: "r1", dialog: "q1" }
      app.commands.setChatReply("project/initial", "01", to)
      const going = app.commands.sendChat(key, "this\none", to)
      expect(answers).toEqual([["r1", { type: "chat", dialog: "q1", text: "this one" }]])
      expect(chatReplyOf(app.ui.getSnapshot().chatReplies, "project/initial", "01")).toEqual(to)
      settle[0]!.resolve()
      await going
      expect(chatReplyOf(app.ui.getSnapshot().chatReplies, "project/initial", "01")).toBeNull()
    })
  })

  context("when held words are edited", () => {
    it("lets go of the hold: they are a message now", () => {
      const app = open({ working: false })
      app.commands.setChatDraft("01", "pick X")
      app.commands.setChatReply("project/initial", "01", "held")
      app.commands.setChatDraft("01", "pick X please")
      expect(chatReplyOf(app.ui.getSnapshot().chatReplies, "project/initial", "01")).toBeNull()
    })
  })

  context("when the agent ends", () => {
    it("shows the terminal again, and a later agent's chat", () => {
      const app = open({ working: false })
      const stop = watchChatModes(app.workspace, app.ui)
      app.status(undefined)
      expect(app.on()).toBe(false)
      app.status({ working: true })
      expect(app.on()).toBe(true)
      stop()
    })

    it("starts a later agent in its chat though the person answered the last in the terminal", () => {
      const app = open(waiting)
      const stop = watchChatModes(app.workspace, app.ui)
      app.commands.showTerminal("01")
      app.status(undefined)
      app.status({ working: false })
      expect(app.on()).toBe(true)
      stop()
    })

    it("keeps an answer in the terminal through a restart, and the draft past the agent", () => {
      const app = open(waiting)
      const stop = watchChatModes(app.workspace, app.ui)
      app.commands.showTerminal("01")
      app.commands.setChatDraft("01", "draft")
      app.workspace.dispatch({
        type: "terminal/status",
        target,
        terminalId: "01",
        status: { state: "starting" },
      })
      expect(app.ui.getSnapshot().answering).not.toEqual({})
      app.workspace.dispatch({
        type: "terminal/status",
        target,
        terminalId: "01",
        status: { state: "exited", exitCode: 0, signal: null },
      })
      expect(app.ui.getSnapshot().answering).toEqual({})
      // The words typed stay, for whatever runs there next.
      expect(app.ui.getSnapshot().chatDrafts).toEqual({ "project/initial": { "01": "draft" } })
      stop()
    })
  })
})
