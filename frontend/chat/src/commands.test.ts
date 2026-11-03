import {
  noConversation,
  type ChatItem,
  type ChatPrompt,
  type Conversation,
  type Conversations,
} from "@novadeck/core/conversation"
import { createStore } from "@novadeck/core/store"
import { refusing } from "@novadeck/core/testing"
import { afterEach, vi } from "vitest"

import { createChatCommands, unseenMs } from "./commands"
import { chatDraftOf } from "./drafts"
import { chatSendsOf } from "./sends"
import { createChat } from "./state"
import { describe, expect, it } from "./test"

const key = { projectId: "project", workspaceSessionId: "initial", terminalId: "01" }
const context = "project/initial"

afterEach(() => void vi.useRealTimers())

const userItem = (index: number, text: string): ChatItem => ({
  id: `s1:${index}`,
  at: null,
  role: "user",
  kind: "text",
  text,
  truncated: false,
  tool: null,
  call: null,
  author: null,
  run: null,
  interrupted: false,
})

// The chat's commands over a backend that follows prompts, whose conversation the test
// moves as the runner would: its receipts by the refs the chat sent with.
const open = (session: string | null = "s1") => {
  const conversation = createStore<Conversation>({ ...noConversation, session, loaded: true })
  const sent: string[] = []
  const refs: string[] = []
  const conversations: Conversations = {
    conversation: () => conversation,
    send: async (_key, text, options) => {
      sent.push(text)
      refs.push(options!.ref!)
      return { tracked: true }
    },
    interrupt: async () => null,
    answer: async () => {},
    refused: refusing(),
  }
  const chat = createChat()
  const commands = createChatCommands({
    chat,
    conversations,
    terminalOpen: () => true,
    context: () => context,
  })
  const phases = () =>
    chatSendsOf(chat.store.getSnapshot().sends, context, "01").map(({ text, phase }) => [
      text,
      phase,
    ])
  const draft = () => chatDraftOf(chat.store.getSnapshot().drafts, context, "01")
  // The receipt of the prompt sent `nth`, as the runner tells it.
  const receipt = (
    nth: number,
    state: ChatPrompt["state"],
    item: number | null = null,
  ): ChatPrompt => ({
    ref: refs[nth]!,
    text: state === "settled" || state === "withdrawn" ? null : sent[nth]!,
    sentAt: nth,
    state,
    item,
  })
  const tell = (change: Partial<Conversation>) =>
    conversation.update((now) => ({ ...now, ...change }))
  // Sends `first`, then queues `second` behind it, with the first's receipt seen pending.
  const two = async (first = "one", second = "two") => {
    await commands.sendChat(key, first, null)
    const queued = commands.sendChat(key, second, null)
    tell({ prompts: [receipt(0, "pending")] })
    expect(phases()).toEqual([
      [first, "sent"],
      [second, "queued"],
    ])
    // In an object, so awaiting the setup doesn't await the queued send too.
    return { queued }
  }
  return { commands, sent, phases, draft, receipt, tell, two }
}

describe("the chat's send queue", () => {
  it("sends the next once the record has the one before, whose words stay until its item arrives", async () => {
    const { sent, phases, receipt, tell, two } = open()
    const { queued } = await two()
    tell({ prompts: [receipt(0, "settled", 0)] })
    await queued
    expect(sent).toEqual(["one", "two"])
    expect(phases()).toEqual([
      ["one", "settled"],
      ["two", "sent"],
    ])
    tell({ items: [userItem(0, "one")] })
    expect(phases()).toEqual([["two", "sent"]])
  })

  it("puts the queued words back in the box when the one before is back in the agent's", async () => {
    const { commands, sent, phases, draft, receipt, tell, two } = open()
    const { queued } = await two()
    commands.setChatDraft("01", "typed meanwhile")
    tell({ prompts: [receipt(0, "in-box")] })
    await queued
    expect(sent).toEqual(["one"])
    expect(phases()).toEqual([])
    expect(draft()).toBe("two\ntyped meanwhile")
  })

  for (const state of ["unrecorded", "withdrawn"] as const)
    it(`sends the next once the one before is ${state}`, async () => {
      const { sent, phases, receipt, tell, two } = open()
      const { queued } = await two()
      tell({ prompts: [receipt(0, state)] })
      await queued
      expect(sent).toEqual(["one", "two"])
      expect(phases()).toEqual([["two", "sent"]])
    })

  for (const [what, gone] of [
    ["the runner restarted, forgetting it", { prompts: [] }],
    ["the agent moved to another session", { session: "s2", prompts: [] }],
    ["the terminal closed", noConversation],
  ] as const)
    it(`sends the next once a receipt seen goes, as when ${what}`, async () => {
      const { sent, phases, tell, two } = open()
      const { queued } = await two()
      tell(gone)
      await queued
      expect(sent).toEqual(["one", "two"])
      expect(phases()).toEqual([["two", "sent"]])
    })

  it("sends the next once the session changes before the receipt was seen", async () => {
    const { commands, sent, tell } = open()
    await commands.sendChat(key, "one", null)
    const queued = commands.sendChat(key, "two", null)
    tell({ session: "s2" })
    await queued
    expect(sent).toEqual(["one", "two"])
  })

  it("stops waiting on a receipt the conversation never shows, and sends the next", async () => {
    vi.useFakeTimers()
    const { commands, sent, phases } = open(null)
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
