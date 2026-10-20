import { createWorkspaceStore } from "@novadeck/core/store"
import { workspaceFixture } from "@novadeck/core/testing"
import type { AgentStatus } from "@novadeck/core/types"

import { setChatDraft, setChatReply } from "./mode-state"
import {
  answerInTerminal,
  createChat,
  dictateIntoDraft,
  resetAnswering,
  watchChat,
  chatDraftOf,
  chatReplyOf,
} from "./state"
import { describe, expect, it } from "./test"

const context = "project/initial"
const target = { projectId: "project", workspaceSessionId: "initial" }

const draftOf = (chat: ReturnType<typeof createChat>): string =>
  chatDraftOf(chat.store.getSnapshot().drafts, context, "01")

describe("words dictated into a draft", () => {
  it("replace an empty or whitespace-only draft", () => {
    const chat = createChat()
    dictateIntoDraft(chat, context, "01", "run the tests")
    expect(draftOf(chat)).toBe("run the tests")
    chat.update((state) => ({
      ...state,
      drafts: setChatDraft(state.drafts, context, "01", " \n "),
    }))
    dictateIntoDraft(chat, context, "01", "again")
    expect(draftOf(chat)).toBe("again")
  })

  it("go after a space, or directly after trailing whitespace", () => {
    const chat = createChat()
    chat.update((state) => ({
      ...state,
      drafts: setChatDraft(state.drafts, context, "01", "Please"),
    }))
    dictateIntoDraft(chat, context, "01", "run it")
    expect(draftOf(chat)).toBe("Please run it")
    chat.update((state) => ({
      ...state,
      drafts: setChatDraft(state.drafts, context, "01", "Line\n"),
    }))
    dictateIntoDraft(chat, context, "01", "next")
    expect(draftOf(chat)).toBe("Line\nnext")
  })

  it("never go on a new line, nor ahead of a shell command", () => {
    const chat = createChat()
    chat.update((state) => ({
      ...state,
      drafts: setChatDraft(state.drafts, context, "01", "!ls"),
    }))
    dictateIntoDraft(chat, context, "01", "-la")
    expect(draftOf(chat)).toBe("!ls -la")
  })

  it("release no held reply", () => {
    const chat = createChat()
    chat.update((state) => ({
      ...state,
      drafts: setChatDraft(state.drafts, context, "01", "pick X"),
      replies: setChatReply(state.replies, context, "01", "held"),
    }))
    dictateIntoDraft(chat, context, "01", "please")
    expect(draftOf(chat)).toBe("pick X please")
    expect(chatReplyOf(chat.store.getSnapshot().replies, context, "01")).toBe("held")
  })
})

describe("the terminals answered in", () => {
  it("are marked and cleared, notifying only on a change", () => {
    const chat = createChat()
    let heard = 0
    chat.store.subscribe(() => heard++)
    resetAnswering(chat)
    expect(heard).toBe(0)
    answerInTerminal(chat, context, "01")
    answerInTerminal(chat, context, "01")
    expect(chat.store.getSnapshot().answering).toEqual({
      [context]: { "01": true },
    })
    expect(heard).toBe(1)
    resetAnswering(chat)
    expect(chat.store.getSnapshot().answering).toEqual({})
    expect(heard).toBe(2)
  })
})

describe("watching the workspace", () => {
  const running = (status: AgentStatus | undefined) => ({
    type: "terminal/status" as const,
    target,
    terminalId: "01",
    status: status ? ({ state: "running", agent: status } as const) : ({ state: "idle" } as const),
  })
  const open = () => {
    const workspace = createWorkspaceStore(workspaceFixture())
    const chat = createChat()
    const stop = watchChat(chat, workspace)
    return { workspace, chat, stop }
  }

  it("drops what an answered-in terminal had once its agent ends", () => {
    const { workspace, chat, stop } = open()
    workspace.dispatch(running({ working: false }))
    answerInTerminal(chat, context, "01")
    workspace.dispatch(running(undefined))
    expect(chat.store.getSnapshot().answering).toEqual({})
    stop()
  })

  it("drops it too once the agent no longer waits on the person", () => {
    const { workspace, chat, stop } = open()
    workspace.dispatch(running({ working: true, attention: { kind: "permission", count: 1 } }))
    answerInTerminal(chat, context, "01")
    workspace.dispatch(running({ working: true, attention: { kind: "permission", count: 1 } }))
    expect(chat.store.getSnapshot().answering).not.toEqual({})
    workspace.dispatch(running({ working: true }))
    expect(chat.store.getSnapshot().answering).toEqual({})
    stop()
  })

  it("keeps a draft past the agent, holds a reply, and drops both once the terminal closes", () => {
    const { workspace, chat, stop } = open()
    workspace.dispatch(running({ working: false }))
    chat.update((state) => ({
      ...state,
      drafts: setChatDraft(state.drafts, context, "01", "pick X"),
      replies: setChatReply(state.replies, context, "01", {
        request: "r",
        dialog: "d",
      }),
    }))
    workspace.dispatch(running(undefined))
    expect(draftOf(chat)).toBe("pick X")
    expect(chatReplyOf(chat.store.getSnapshot().replies, context, "01")).toBe("held")
    workspace.dispatch({ type: "terminal/close", target, terminalId: "01" })
    expect(chat.store.getSnapshot().drafts).toEqual({})
    expect(chat.store.getSnapshot().replies).toEqual({})
    stop()
  })

  it("stops listening once stopped", () => {
    const { workspace, chat, stop } = open()
    chat.update((state) => ({
      ...state,
      drafts: setChatDraft(state.drafts, context, "01", "x"),
    }))
    stop()
    workspace.dispatch({ type: "terminal/close", target, terminalId: "01" })
    expect(draftOf(chat)).toBe("x")
  })
})
