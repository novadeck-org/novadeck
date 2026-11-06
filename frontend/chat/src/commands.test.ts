import {
  noConversation,
  withReturned,
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
import { setAnsweringInTerminal } from "./shown"
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
  outcome: null,
  scripted: false,
  interrupted: false,
})

// The chat's commands over a backend that follows prompts, whose conversation the test
// moves as the runner would: its receipts by the refs the chat sent with.
const open = (
  session: string | null = "s1",
  {
    interrupt = async () => null,
    answer = async () => {},
    returned = null,
    sends,
    takeBox,
    putBox,
    chatView = true,
  }: {
    readonly interrupt?: () => Promise<string | null>
    readonly answer?: () => Promise<void>
    readonly returned?: string | null
    readonly sends?: () => void
    readonly takeBox?: Conversations["takeBox"]
    readonly putBox?: Conversations["putBox"]
    readonly chatView?: boolean
  } = {},
) => {
  const conversation = createStore<Conversation>({ ...noConversation, session, loaded: true })
  const sent: string[] = []
  const refs: string[] = []
  let lastOptions: unknown
  const conversations: Conversations = {
    conversation: () => conversation,
    send: async (_key, text, options) => {
      sent.push(text)
      refs.push(options!.ref!)
      lastOptions = options
      sends?.()
      return { tracked: true, returned }
    },
    interrupt,
    answer,
    refused: refusing(),
    ...(takeBox && { takeBox }),
    ...(putBox && { putBox }),
  }
  const chat = createChat()
  const commands = createChatCommands({
    chat,
    conversations,
    terminalOpen: () => true,
    context: () => context,
    chatView: () => chatView,
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
  return {
    commands,
    sent,
    phases,
    draft,
    reply,
    receipt,
    tell,
    two,
    chat,
    sentOptions: () => lastOptions,
  }
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

  it("puts words a prompt took out of the agent's box in the chat's, before what's typed", async () => {
    const { commands, draft } = open("s1", { returned: "came back" })
    const sending = commands.sendChat(key, "the message", null)
    commands.setChatDraft("01", "typed since")
    await expect(sending).resolves.toBe(true)
    expect(draft()).toBe("came back\ntyped since")
  })

  it("puts them back as well when the prompt failed after it took them, ahead of its own", async () => {
    const { commands, draft } = open("s1", {
      sends: () => {
        throw withReturned(new Error("It didn't land."), "came back")
      },
    })
    commands.setChatDraft("01", "the message")
    await expect(commands.sendChat(key, "the message", null)).rejects.toThrow("It didn't land.")
    expect(draft()).toBe("came back\nthe message")
  })

  it("waits for a take on its way before it puts the draft back", async () => {
    let finish: (words: string) => void = () => {}
    const put: string[] = []
    const { commands, draft } = open("s1", {
      takeBox: () => new Promise((resolve) => (finish = resolve)),
      putBox: async (_key, text) => {
        put.push(text)
        return true
      },
    })
    commands.setChatDraft("01", "from the chat")
    const taking = commands.takeBox(key)
    const putting = commands.putDraft(key)
    finish("from the box")
    await Promise.all([taking, putting])
    expect(put).toEqual(["from the box\n\nfrom the chat"])
    expect(draft()).toBe("")
  })

  it("asks that what the agent's box holds goes along, only while the chat shows", async () => {
    const { chat, commands, sentOptions } = open()
    await commands.sendChat(key, "the message", null)
    expect(sentOptions()).toMatchObject({ along: true })
    chat.update((state) => ({
      ...state,
      answering: setAnsweringInTerminal(state.answering, context, "01", true),
    }))
    await commands.sendChat(key, "behind it", null).catch(() => undefined)
    expect(sentOptions()).not.toHaveProperty("along")
  })

  it("asks nothing go along where the chat view went off", async () => {
    const { commands, sentOptions } = open("s1", { chatView: false })
    await commands.sendChat(key, "the message", null)
    expect(sentOptions()).not.toHaveProperty("along")
  })

  it("leaves in the agent's box what doesn't mix with what's written", async () => {
    const asked: unknown[] = []
    const { commands, draft, tell } = open("s1", {
      takeBox: async (at) => {
        asked.push(at)
        return "!ls"
      },
    })
    tell({ box: { text: "ls", mode: "shell", tail: false, known: false } })
    commands.setChatDraft("01", "from the chat")
    await commands.takeBox(key)
    expect(asked).toEqual([])
    expect(draft()).toBe("from the chat")
  })

  it("adds nothing a paste that landed unseen left in both", async () => {
    const { commands, draft } = open("s1", { takeBox: async () => "the words" })
    commands.setChatDraft("01", "the words")
    await commands.takeBox(key)
    expect(draft()).toBe("the words")
  })

  it("takes what the agent's box holds ahead of what's written, a blank line between", async () => {
    const { commands, draft } = open("s1", { takeBox: async () => "from the box" })
    commands.setChatDraft("01", "from the chat")
    await commands.takeBox(key)
    expect(draft()).toBe("from the box\n\nfrom the chat")
  })

  it("leaves the chat's box as it is where nothing was taken", async () => {
    const { commands, draft } = open("s1", { takeBox: async () => null })
    commands.setChatDraft("01", "from the chat")
    await commands.takeBox(key)
    expect(draft()).toBe("from the chat")
  })

  it("empties the chat's box once its words are in the agent's", async () => {
    const put: string[] = []
    const { commands, draft } = open("s1", {
      putBox: async (_key, text) => {
        put.push(text)
        return true
      },
    })
    commands.setChatDraft("01", "a draft")
    await commands.putDraft(key)
    expect(put).toEqual(["a draft"])
    expect(draft()).toBe("")
  })

  it("keeps the draft where the agent's box didn't take it, or it changed meanwhile", async () => {
    const declined = open("s1", { putBox: async () => false })
    declined.commands.setChatDraft("01", "a draft")
    await declined.commands.putDraft(key)
    expect(declined.draft()).toBe("a draft")

    const changing = open("s1", {
      putBox: async () => {
        changing.commands.setChatDraft("01", "a draft and more")
        return true
      },
    })
    changing.commands.setChatDraft("01", "a draft")
    await changing.commands.putDraft(key)
    expect(changing.draft()).toBe("a draft and more")
  })

  it("puts nothing while a reply is written, words are on their way, or nothing's there", async () => {
    const put: string[] = []
    const putBox = async (_key: unknown, text: string) => {
      put.push(text)
      return true
    }
    const { commands, two } = open("s1", { putBox })
    await commands.putDraft(key)
    const { queued } = await two()
    commands.setChatDraft("01", "more")
    await commands.putDraft(key)
    expect(put).toEqual([])
    void queued.catch(() => undefined)
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
