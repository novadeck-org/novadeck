import { noConversation, type Conversation, type Conversations } from "@novadeck/core/conversation"
import { createStore } from "@novadeck/core/store"
import { describe, expect, it, vi } from "vitest"

import { createLongReplies, longTurns } from "./long-replies"
import type { DemoActionContext } from "./types"

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }

describe("the debug panel's long replies", () => {
  it("are three turns, each a prompt and a reply long enough to fold", () => {
    const turns = longTurns(10 * 60_000)
    expect(turns.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ])
    for (const reply of turns.filter(({ role }) => role === "assistant"))
      expect(reply.text.length).toBeGreaterThan(2_000)
    const times = turns.map(({ at }) => at ?? 0)
    expect(times).toEqual(times.toSorted((a, b) => a - b))
  })

  it("join the selected agent's chat, and go again", () => {
    const base = createStore<Conversation>(noConversation)
    const conversations = { conversation: () => base } as unknown as Conversations
    const replies = createLongReplies()
    const chat = replies.wrap(conversations).conversation(key)
    const told = vi.fn<() => void>()
    chat.subscribe(told)
    const context = {
      selected: () => key,
      note: vi.fn<(text: string) => void>(),
    } as unknown as DemoActionContext
    replies.actions[0]!.run(context)
    expect(chat.getSnapshot().items).toHaveLength(6)
    expect(told).toHaveBeenCalled()
    replies.actions[1]!.run(context)
    expect(chat.getSnapshot().items).toHaveLength(0)
  })
})
