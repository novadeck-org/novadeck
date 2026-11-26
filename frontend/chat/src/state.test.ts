import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { workspaceFixture } from "@novadeck/core/testing"
import type { AgentStatus } from "@novadeck/core/types"
import { afterEach, beforeEach, vi } from "vitest"

import type { Attachment } from "./attachments"
import { setChatReply } from "./replies"
import type { ChatSend } from "./sends"
import {
  answerInTerminal,
  createChat,
  dictateIntoDraft,
  resetAnswering,
  watchChat,
  chatAttachmentsOf,
  chatDraftOf,
  chatReplyOf,
  setChatDraft,
} from "./state"
import { context as situation, describe, expect, it } from "./test"

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

  // The shipping gate's card asks without waiting, and stays open while the dialog is answered.
  it("drops it once the dialog is answered, though a card that asks without waiting stands", () => {
    const { workspace, chat, stop } = open()
    workspace.dispatch(running({ working: true, attention: { kind: "permission", count: 2 } }))
    answerInTerminal(chat, context, "01")
    workspace.dispatch(
      running({ working: false, attention: { kind: "permission", count: 1, detached: true } }),
    )
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

  situation("for a terminal that moved to another session of its project", () => {
    const other = "project/other"
    const image = (id: string): Attachment => ({
      id,
      n: 1,
      name: "shot.png",
      preview: `blob:${id}`,
      state: "ready",
      path: `/tmp/${id}.png`,
      error: null,
    })
    const send: ChatSend = {
      ref: "ref",
      draft: "on its way",
      text: "on its way",
      images: [],
      at: [],
      to: null,
      phase: "sent",
    }
    // Two sessions, the second holding none of the first's terminals, which 01 then moves to.
    const moving = () => {
      const fixture = workspaceFixture({ sessions: ["initial", "other"] })
      const empty = (["01", "02"] as const).reduce(
        (workspace, terminalId) =>
          workspaceReducer(workspace, {
            type: "terminal/close",
            target: { projectId: "project", workspaceSessionId: "other" },
            terminalId,
          }),
        fixture,
      )
      const workspace = createWorkspaceStore(empty)
      // An agent at rest runs in it.
      workspace.dispatch(running({ working: false }))
      const chat = createChat()
      const stop = watchChat(chat, workspace)
      const terminal = workspace.getSnapshot().projects[0]!.history[0]!.state.roster.terminals[0]!
      const move = () =>
        workspace.dispatch({
          type: "terminal/move",
          projectId: "project",
          from: "initial",
          to: "other",
          terminal,
        })
      return { workspace, chat, stop, move }
    }
    const revoked = vi.fn<(url: string) => void>()
    beforeEach(() => {
      revoked.mockClear()
      vi.stubGlobal("URL", Object.assign(Object.create(URL), { revokeObjectURL: revoked }))
    })
    afterEach(() => void vi.unstubAllGlobals())

    it("takes everything the chat kept for it there, its images still shown", () => {
      const { chat, stop, move } = moving()
      chat.update((state) => ({
        ...state,
        drafts: setChatDraft(state.drafts, context, "01", "half a thought"),
        attachments: { [context]: { "01": [image("a")] } },
        imageNotes: { [context]: { "01": "The box holds 3 images at most, so 1 didn't fit." } },
        replies: setChatReply(state.replies, context, "01", { request: "r", dialog: "d" }),
        shells: { [context]: { "01": [{ text: "!ls", at: 1 }] } },
        answering: { [context]: { "01": true } },
        sends: { [context]: { "01": [send] } },
      }))
      move()
      const held = chat.store.getSnapshot()
      expect(chatDraftOf(held.drafts, other, "01")).toBe("half a thought")
      expect(chatAttachmentsOf(held.attachments, other, "01")).toEqual([image("a")])
      expect(revoked).not.toHaveBeenCalled()
      expect(held.imageNotes).toEqual({ [other]: { "01": expect.any(String) } })
      // Its agent goes on there, still asking: the reply is still to its question.
      expect(chatReplyOf(held.replies, other, "01")).toEqual({ request: "r", dialog: "d" })
      expect(held.shells).toEqual({ [other]: { "01": [{ text: "!ls", at: 1 }] } })
      expect(held.sends).toEqual({ [other]: { "01": [send] } })
      expect(held.answering).toEqual({ [other]: { "01": true } })
      stop()
    })

    it("keeps what the chat there holds already, and lets go of the images that lost", () => {
      const { chat, stop, move } = moving()
      chat.update((state) => ({
        ...state,
        drafts: { [context]: { "01": "old" }, [other]: { "01": "new" } },
        attachments: { [context]: { "01": [image("a")] }, [other]: { "01": [image("b")] } },
      }))
      move()
      const held = chat.store.getSnapshot()
      expect(held.drafts).toEqual({ [other]: { "01": "new" } })
      expect(held.attachments).toEqual({ [other]: { "01": [image("b")] } })
      expect(revoked).toHaveBeenCalledExactlyOnceWith("blob:a")
      stop()
    })
  })

  it("drops a closed terminal's shell history and image notes, with nothing else kept", () => {
    const { workspace, chat, stop } = open()
    chat.update((state) => ({
      ...state,
      imageNotes: { [context]: { "01": "note" } },
      shells: { [context]: { "01": [{ text: "!ls", at: 1 }] } },
    }))
    workspace.dispatch({ type: "terminal/close", target, terminalId: "01" })
    expect(chat.store.getSnapshot().imageNotes).toEqual({})
    expect(chat.store.getSnapshot().shells).toEqual({})
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
