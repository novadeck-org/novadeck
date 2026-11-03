import { noConversation, type Conversation, type Conversations } from "@novadeck/core/conversation"
import { createStore } from "@novadeck/core/store"
import { refusing } from "@novadeck/core/testing"
import { afterEach, vi } from "vitest"

import { createChatCommands, unseenMs } from "./commands"
import { chatSendsOf } from "./sends"
import { createChat } from "./state"
import { describe, expect, it } from "./test"

const key = { projectId: "project", workspaceSessionId: "initial", terminalId: "01" }

afterEach(() => void vi.useRealTimers())

// The chat's commands over a backend that follows prompts, whose conversation is `conversation`.
const open = (conversation = createStore<Conversation>({ ...noConversation, session: null })) => {
  const sent: string[] = []
  const conversations: Conversations = {
    conversation: () => conversation,
    send: async (_key, text) => (sent.push(text), { tracked: true }),
    interrupt: async () => null,
    answer: async () => {},
    refused: refusing(),
  }
  const chat = createChat()
  const commands = createChatCommands({
    chat,
    conversations,
    terminalOpen: () => true,
    context: () => "project/initial",
  })
  const phases = () =>
    chatSendsOf(chat.store.getSnapshot().sends, "project/initial", "01").map(({ text, phase }) => [
      text,
      phase,
    ])
  return { commands, sent, phases }
}

describe("the chat's send queue", () => {
  it("stops waiting on a receipt the conversation never shows, and sends the next", async () => {
    vi.useFakeTimers()
    const { commands, sent, phases } = open()
    await commands.sendChat(key, "one", null)
    const second = commands.sendChat(key, "two", null)
    expect(phases()).toEqual([
      ["one", "sent"],
      ["two", "queued"],
    ])
    await vi.advanceTimersByTimeAsync(unseenMs - 1)
    expect(sent).toEqual(["one"])
    await vi.advanceTimersByTimeAsync(1)
    await second
    expect(sent).toEqual(["one", "two"])
  })
})
