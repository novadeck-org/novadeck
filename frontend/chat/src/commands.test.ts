import {
  noConversation,
  noDoorbell,
  RingUnderWay,
  SettleInTerminal,
  withReturned,
  type BoxReturn,
  type ChatItem,
  type ChatPrompt,
  type ChatRequest,
  type Conversation,
  type Conversations,
} from "@novadeck/core/conversation"
import { createStore } from "@novadeck/core/store"
import { refusing } from "@novadeck/core/testing"
import { afterEach, beforeEach, vi } from "vitest"

import { createChatCommands, ringRetryMs, ringWaitMs, unseenMs } from "./commands"
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
  ring: null,
})

// The chat's commands over a backend that follows prompts, whose conversation the test
// moves as the runner would: its receipts by the refs the chat sent with.
const open = (
  session: string | null = "s1",
  {
    interrupt = async () => ({ words: null }),
    answer = async () => {},
    returned = null,
    sends,
    takeBox,
    putBox,
    clearBox,
    chatView = true,
  }: {
    readonly interrupt?: Conversations["interrupt"]
    readonly answer?: () => Promise<void>
    readonly returned?: string | null
    readonly sends?: () => void
    readonly takeBox?: Conversations["takeBox"]
    readonly putBox?: Conversations["putBox"]
    readonly clearBox?: Conversations["clearBox"]
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
    ...(clearBox && { clearBox }),
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

  it("leaves the box to a menu of the harness's own, and to the chat's own keys", async () => {
    const taken = vi.fn<NonNullable<Conversations["takeBox"]>>(async () => ({ words: "taken" }))
    const box = { text: "look at @sr", mode: "prompt", tail: false, known: false } as const
    const menu = { reason: "menu", columns: 80, rows: [[]], cursor: null, secret: false } as const
    const withMenu = open("s1", { takeBox: taken })
    withMenu.tell({ box, slice: menu })
    await withMenu.commands.takeBox(key)
    const typing = open("s1", { takeBox: taken })
    typing.tell({ box })
    typing.commands.setChatDraft("01", "look at @src")
    await typing.commands.takeBox(key)
    const passing = open("s1", { takeBox: taken })
    passing.tell({ box: { ...box, text: "look at @src/file.ts" } })
    passing.commands.setChatPassing("01", true)
    await passing.commands.takeBox(key)
    expect(taken).not.toHaveBeenCalled()
  })

  it("waits for a take on its way before it puts the draft back", async () => {
    let finish: (words: BoxReturn) => void = () => {}
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
    finish({ words: "from the box" })
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
        return { words: "!ls" }
      },
    })
    tell({ box: { text: "ls", mode: "shell", tail: false, known: false } })
    commands.setChatDraft("01", "from the chat")
    await commands.takeBox(key)
    expect(asked).toEqual([])
    expect(draft()).toBe("from the chat")
  })

  describe("while the doorbell rings its agent", () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())
    const ringing = { ...noDoorbell, ringing: true }

    it("holds a message in the queue, and sends it once the ring is over", async () => {
      const { commands, phases, sent, tell } = open()
      tell({ doorbell: ringing })
      void commands.sendChat(key, "behind the ring", null)
      expect(phases()).toEqual([["behind the ring", "queued"]])
      expect(sent).toEqual([])
      tell({ doorbell: noDoorbell })
      expect(sent).toEqual(["behind the ring"])
    })

    it("keeps the order of those it holds", async () => {
      const { commands, sent, tell, receipt } = open()
      tell({ doorbell: ringing })
      void commands.sendChat(key, "first", null)
      void commands.sendChat(key, "second", null)
      tell({ doorbell: noDoorbell })
      expect(sent).toEqual(["first"])
      await vi.advanceTimersByTimeAsync(0)
      tell({ prompts: [receipt(0, "settled", 0)], items: [userItem(0, "first")] })
      await vi.advanceTimersByTimeAsync(0)
      expect(sent).toEqual(["first", "second"])
    })

    it("tries again what the agent turned away for a ring, with no failure said", async () => {
      let refusals = 1
      const { commands, phases, sent, draft } = open("s1", {
        sends: () => {
          if (refusals-- > 0) throw new RingUnderWay("Reaching it right now.")
        },
      })
      const going = commands.sendChat(key, "the words", null)
      await vi.advanceTimersByTimeAsync(0)
      expect(phases()).toEqual([["the words", "queued"]])
      expect(draft()).toBe("")
      await vi.advanceTimersByTimeAsync(ringRetryMs)
      await expect(going).resolves.toBe(true)
      expect(sent).toEqual(["the words", "the words"])
    })

    it("says so once it has waited too long, the words back in the box", async () => {
      const { commands, draft } = open("s1", {
        sends: () => {
          throw new RingUnderWay("Reaching it right now.")
        },
      })
      const going = commands.sendChat(key, "the words", null)
      const failed = expect(going).rejects.toThrow("Reaching it right now.")
      await vi.advanceTimersByTimeAsync(ringWaitMs + ringRetryMs)
      await failed
      expect(draft()).toBe("the words")
    })

    it("sends what it held after a ring that never ends, for the agent to say", async () => {
      const { commands, sent, tell } = open()
      tell({ doorbell: ringing })
      void commands.sendChat(key, "the words", null)
      await vi.advanceTimersByTimeAsync(ringWaitMs)
      expect(sent).toEqual(["the words"])
    })

    it("hands back what a Stop takes out of the queue, and sends nothing after", async () => {
      const { commands, sent, tell, draft } = open()
      tell({ doorbell: ringing })
      void commands.sendChat(key, "the words", null)
      await commands.stopChat(key)
      tell({ doorbell: noDoorbell })
      expect(sent).toEqual([])
      expect(draft()).toBe("the words")
    })
  })

  it("clears the box the person was shown, whatever it holds by now", async () => {
    const asked: unknown[] = []
    let cleared = true
    const { commands, tell } = open("s1", {
      clearBox: async (at, seen) => {
        asked.push([at, seen])
        return cleared
      },
    })
    tell({ box: { text: "/typed since", mode: "prompt", tail: false, known: false } })
    await commands.clearBox(key, "/model")
    expect(asked).toEqual([[key, "/model"]])
    cleared = false
    await expect(commands.clearBox(key, "/model")).rejects.toBeInstanceOf(SettleInTerminal)
  })

  it("adds nothing a paste that landed unseen left in both", async () => {
    const { commands, draft } = open("s1", { takeBox: async () => ({ words: "the words" }) })
    commands.setChatDraft("01", "the words")
    await commands.takeBox(key)
    expect(draft()).toBe("the words")
  })

  it("takes what the agent's box holds ahead of what's written, a blank line between", async () => {
    const { commands, draft } = open("s1", { takeBox: async () => ({ words: "from the box" }) })
    commands.setChatDraft("01", "from the chat")
    await commands.takeBox(key)
    expect(draft()).toBe("from the box\n\nfrom the chat")
  })

  it("leaves the chat's box as it is where nothing was taken", async () => {
    const { commands, draft } = open("s1", { takeBox: async () => ({ words: null }) })
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
      interrupt: async () => ({ words: "in the agent's box" }),
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

describe("a Send or Stop over a question the agent asks", () => {
  const request = (id: string, kind: ChatRequest["kind"]): ChatRequest => ({
    id,
    kind,
    tool: kind === "question" ? "AskUserQuestion" : "Bash",
    subject: null,
    choices: [],
    subagent: false,
    dialog:
      kind === "question"
        ? { type: "questions", id: `${id}:d`, chat: "prompt", questions: [] }
        : { type: "choices", id: `${id}:d`, title: null, detail: null, options: [] },
    answered: false,
    askedAt: 0,
  })
  const setAsides = (chat: ReturnType<typeof open>["chat"]) =>
    chatSendsOf(chat.store.getSnapshot().sends, context, "01").map((send) => send.setAside)

  it("sets the question aside for the person's message, naming it on the send", async () => {
    const { chat, commands, sentOptions, tell } = open()
    tell({ requests: [request("q1", "question")] })
    const going = commands.sendChat(key, "Do this instead", null)
    expect(setAsides(chat)).toEqual([["q1"]])
    await going
    expect(sentOptions()).toMatchObject({ along: true, setAside: ["q1"] })
  })

  it("never for a shell command, a permission, or a question already answered", async () => {
    const { commands, sentOptions, tell } = open()
    tell({ requests: [request("q1", "question")] })
    await commands.sendChat(key, "!ls", null)
    expect(sentOptions()).not.toHaveProperty("setAside")
    tell({ requests: [request("p1", "permission")], prompts: [] })
    await commands.sendChat(key, "Go on", null).catch(() => undefined)
    expect(sentOptions()).not.toHaveProperty("setAside")
  })

  it("leaves a question asked after the words were queued for the person to see", async () => {
    const { commands, sent, receipt, sentOptions, tell } = open()
    await commands.sendChat(key, "one", null)
    const queued = commands.sendChat(key, "two", null)
    tell({ prompts: [receipt(0, "pending")], requests: [request("q1", "question")] })
    tell({ prompts: [receipt(0, "settled", 0)] })
    await queued
    expect(sent).toEqual(["one", "two"])
    expect(sentOptions()).not.toHaveProperty("setAside")
  })

  it("sets aside only a question it was sent over that still waits as its turn comes", async () => {
    const { commands, receipt, sentOptions, tell } = open()
    await commands.sendChat(key, "one", null)
    tell({ requests: [request("q1", "question")] })
    const second = commands.sendChat(key, "two", null)
    const third = commands.sendChat(key, "three", null)
    // q1 went while they waited, and the agent asks q2: neither was written over it.
    tell({ prompts: [receipt(0, "pending")], requests: [request("q2", "question")] })
    tell({ prompts: [receipt(0, "settled", 0)] })
    await second
    expect(sentOptions()).not.toHaveProperty("setAside")
    tell({ prompts: [receipt(1, "settled", 1)], requests: [request("q1", "question")] })
    await third
    expect(sentOptions()).toMatchObject({ setAside: ["q1"] })
  })

  it("never names a question that asks without waiting, and names no more than one Send takes", async () => {
    const given: unknown[] = []
    const { commands, sentOptions, tell } = open("s1", {
      interrupt: async (_key, options) => {
        given.push(options)
        return { words: null }
      },
    })
    tell({ requests: [{ ...request("a1", "question"), detached: true }] })
    await commands.sendChat(key, "Go on", null)
    expect(sentOptions()).not.toHaveProperty("setAside")
    await commands.stopChat(key)
    const many = Array.from({ length: 10 }, (_, index) => request(`q${index}`, "question"))
    tell({ requests: [{ ...request("a1", "question"), detached: true }, ...many] })
    await commands.stopChat(key)
    expect(given).toEqual([undefined, { setAside: many.slice(0, 8).map(({ id }) => id) }])
  })

  it("comes back to the box with why, where the runner turns it away", async () => {
    const { chat, commands, draft, tell } = open("s1", {
      sends: () => {
        throw new Error("The agent is waiting for your answer. Answer it here, then send again.")
      },
    })
    tell({ requests: [request("p1", "permission"), request("q1", "question")] })
    commands.setChatDraft("01", "Do this instead")
    await expect(commands.sendChat(key, "Do this instead", null)).rejects.toThrow(
      "waiting for your answer",
    )
    expect(draft()).toBe("Do this instead")
    expect(setAsides(chat)).toEqual([])
  })

  it("stops the agent, setting the question aside, and only then", async () => {
    const given: unknown[] = []
    const { commands, tell } = open("s1", {
      interrupt: async (_key, options) => {
        given.push(options)
        return { words: null }
      },
    })
    tell({ requests: [request("q1", "question")] })
    await commands.stopChat(key)
    tell({ requests: [request("p1", "permission")] })
    await commands.stopChat(key)
    tell({ requests: [{ ...request("q2", "question"), answered: true }] })
    await commands.stopChat(key)
    expect(given).toEqual([{ setAside: ["q1"] }, undefined, undefined])
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
