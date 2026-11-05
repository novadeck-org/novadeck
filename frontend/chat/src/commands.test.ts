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
import { chatReplyOf } from "./replies"
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
const open = (
  session: string | null = "s1",
  {
    interrupt = async () => null,
    answer = async () => {},
  }: {
    readonly interrupt?: () => Promise<string | null>
    readonly answer?: () => Promise<void>
  } = {},
) => {
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
    interrupt,
    answer,
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
  const reply = () => chatReplyOf(chat.store.getSnapshot().replies, context, "01")
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
    await expect(commands.sendChat(key, first, null)).resolves.toBe(true)
    const queued = commands.sendChat(key, second, null)
    tell({ prompts: [receipt(0, "pending")] })
    expect(phases()).toEqual([
      [first, "sent"],
      [second, "queued"],
    ])
    // In an object, so awaiting the setup doesn't await the queued send too.
    return { queued }
  }
  return { commands, sent, phases, draft, reply, receipt, tell, two }
}

describe("the chat's send queue", () => {
  it("sends the next once the record has the one before, whose words stay until its item arrives", async () => {
    const { sent, phases, receipt, tell, two } = open()
    const { queued } = await two()
    tell({ prompts: [receipt(0, "settled", 0)] })
    await expect(queued).resolves.toBe(true)
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
    // Back in the box unsent.
    await expect(queued).resolves.toBe(false)
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

describe("a Stop from the chat", () => {
  it("hands back the queued words after the agent's, before the box's, and sends none after it", async () => {
    const { commands, sent, phases, draft, two } = open("s1", {
      interrupt: async () => "in the agent's box",
    })
    const { queued } = await two()
    const third = commands.sendChat(key, "three", null)
    commands.setChatDraft("01", "typed meanwhile")
    await commands.stopChat(key)
    // Back in the box unsent: neither went.
    await expect(queued).resolves.toBe(false)
    await expect(third).resolves.toBe(false)
    expect(draft()).toBe("in the agent's box\ntwo\nthree\ntyped meanwhile")
    expect(sent).toEqual(["one"])
    // The prompt that went stays followed.
    expect(phases()).toEqual([["one", "sent"]])
  })

  it("hands back the queued words though the interrupt fails, and says why", async () => {
    const { commands, sent, draft, two } = open("s1", {
      interrupt: () => Promise.reject(new Error("The runner is offline.")),
    })
    const { queued } = await two()
    await expect(commands.stopChat(key)).rejects.toThrow("The runner is offline.")
    await expect(queued).resolves.toBe(false)
    expect(draft()).toBe("two")
    expect(sent).toEqual(["one"])
  })
})

describe("a reply from the chat", () => {
  const to = { request: "r1", dialog: "q1" }

  it("ends once it took, holding words typed while it went for the person's edit", async () => {
    let land = (): void => {}
    const { commands, draft, reply } = open("s1", {
      answer: () => new Promise<void>((resolve) => (land = resolve)),
    })
    commands.setChatReply(context, "01", to)
    const going = commands.sendChat(key, "pick X", to)
    commands.setChatDraft("01", "and then Y")
    land()
    await expect(going).resolves.toBe(true)
    expect(draft()).toBe("and then Y")
    expect(reply()).toBe("held")
  })

  it("ends once it took, with nothing to hold where nothing was typed", async () => {
    const { commands, reply } = open()
    commands.setChatReply(context, "01", to)
    await expect(commands.sendChat(key, "pick X", to)).resolves.toBe(true)
    expect(reply()).toBeNull()
  })

  it("comes back before words typed while it went, when it fails, still a reply", async () => {
    let fail = (_failure: unknown): void => {}
    const { commands, draft, reply } = open("s1", {
      answer: () => new Promise<void>((_resolve, reject) => (fail = reject)),
    })
    commands.setChatReply(context, "01", to)
    const going = commands.sendChat(key, "pick X", to)
    commands.setChatDraft("01", "and then Y")
    fail(new Error("The question went."))
    await expect(going).rejects.toThrow("The question went.")
    expect(draft()).toBe("pick X\nand then Y")
    expect(reply()).toEqual(to)
  })
})
