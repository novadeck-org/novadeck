import {
  noConversation,
  noDoorbell,
  InDoubt,
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
import type { TerminalKey } from "@novadeck/core/types"
import { afterEach, beforeEach, vi } from "vitest"

import { rehomeTerminals } from "./by-terminal"
import {
  createChatCommands,
  inDoubtNote,
  ringRetryMs,
  ringWaitMs,
  startLookMs,
  unseenMs,
} from "./commands"
import { chatDraftOf } from "./drafts"
import { chatReplyOf } from "./replies"
import { chatSendsOf } from "./sends"
import { setAnsweringInTerminal } from "./shown"
import { createChat } from "./state"
import { context as situation, describe, expect, it } from "./test"

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
    starting,
  }: {
    readonly interrupt?: Conversations["interrupt"]
    readonly answer?: () => Promise<void>
    readonly returned?: string | null
    readonly sends?: () => void
    readonly takeBox?: Conversations["takeBox"]
    readonly putBox?: Conversations["putBox"]
    readonly clearBox?: Conversations["clearBox"]
    readonly chatView?: boolean
    readonly starting?: () => boolean
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
  // Where terminal 01 is now: moved to another session, as the runner may, or closed.
  let here: TerminalKey | null = key
  const commands = createChatCommands({
    chat,
    conversations,
    locate: (asked) => (here && asked.terminalId === here.terminalId ? here : null),
    context: () => context,
    chatView: () => chatView,
    ...(starting && { starting }),
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
  // The terminal moves to session `to`, and the chat's state goes with it, as `watchChat`
  // takes it there.
  const move = (to: string) => {
    const from = context
    here = { ...key, workspaceSessionId: to }
    const home = (at: string) => (at === from ? `project/${to}` : undefined)
    chat.update((state) => ({
      ...state,
      drafts: rehomeTerminals(state.drafts, home),
      attachments: rehomeTerminals(state.attachments, home),
      sends: rehomeTerminals(state.sends, home),
    }))
  }
  // The terminal closes.
  const close = () => {
    here = null
  }
  return {
    commands,
    sent,
    phases,
    draft,
    move,
    close,
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
    typing.commands.setChatPassing("01", "ending")
    await typing.commands.takeBox(key)
    const passing = open("s1", { takeBox: taken })
    passing.tell({ box: { ...box, text: "look at @src/file.ts" } })
    passing.commands.setChatPassing("01", "on")
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

  describe("while its agent starts", () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    it("holds what is sent until the agent is ready, in order", async () => {
      let starting = true
      const { commands, phases, sent } = open(null, { starting: () => starting })
      void commands.sendChat(key, "first", null)
      void commands.sendChat(key, "second", null)
      expect(phases()).toEqual([
        ["first", "queued"],
        ["second", "queued"],
      ])
      await vi.advanceTimersByTimeAsync(startLookMs * 8)
      expect(sent).toEqual([])
      // Its prompt shows: the terminal says so, looked at in turn.
      starting = false
      await vi.advanceTimersByTimeAsync(startLookMs)
      expect(sent).toEqual(["first"])
      expect(phases()).toEqual([
        ["first", "sent"],
        ["second", "queued"],
      ])
    })

    it("goes on as the conversation tells of its session, without waiting for a look", async () => {
      let starting = true
      const { commands, sent, tell } = open(null, { starting: () => starting })
      void commands.sendChat(key, "hello", null)
      starting = false
      tell({ agent: "claude", session: "s1" })
      expect(sent).toEqual(["hello"])
    })
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

  it("takes words typed ahead that the draft starts like, where the chat passed no keys", async () => {
    const taken = vi.fn<NonNullable<Conversations["takeBox"]>>(async () => ({ words: "aaaaaaaa" }))
    const { commands, draft, tell } = open("s1", { takeBox: taken })
    tell({ box: { text: "aaaaaaaa", mode: "prompt", tail: false, known: false } })
    commands.setChatDraft("01", "a")
    await commands.takeBox(key, { ahead: true })
    expect(taken).toHaveBeenCalledOnce()
    expect(draft()).toBe("aaaaaaaaa")
  })

  it("adds no words typed ahead that the draft holds already", async () => {
    const { commands, draft } = open("s1", { takeBox: async () => ({ words: "the words" }) })
    commands.setChatDraft("01", "the words")
    await commands.takeBox(key, { ahead: true })
    expect(draft()).toBe("the words")
  })

  it("leaves the box to the keys passed to a menu a while after passing stopped", async () => {
    vi.useFakeTimers()
    try {
      const taken = vi.fn<NonNullable<Conversations["takeBox"]>>(async () => ({ words: "/mod" }))
      const { commands, tell } = open("s1", { takeBox: taken })
      tell({ box: { text: "/mod", mode: "prompt", tail: false, known: false } })
      commands.setChatDraft("01", "/mode")
      commands.setChatPassing("01", "on")
      commands.setChatPassing("01", "off")
      expect(await commands.takeBox(key)).toBe(false)
      vi.advanceTimersByTime(2000)
      expect(await commands.takeBox(key)).toBe(true)
      expect(taken).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it("goes on from words typed ahead as the agent started with what was typed in the chat", async () => {
    const { commands, draft } = open("s1", {
      takeBox: async () => ({ words: "fix the bug in the par" }),
    })
    commands.setChatDraft("01", "ser")
    await commands.takeBox(key, { ahead: true })
    expect(draft()).toBe("fix the bug in the parser")
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

  situation("for a terminal that moved to another session meanwhile", () => {
    const moved = "project/other"
    const phasesAt = (chat: ReturnType<typeof open>["chat"], at: string) =>
      chatSendsOf(chat.store.getSnapshot().sends, at, "01").map(({ text, phase }) => [text, phase])

    it("sends the queued words there, and each leaves the queue there", async () => {
      const { chat, sent, receipt, tell, two, move } = open()
      const { queued } = await two()
      move("other")
      tell({ prompts: [receipt(0, "settled", 0)] })
      await expect(queued).resolves.toBe(true)
      expect(sent).toEqual(["one", "two"])
      expect(phasesAt(chat, moved)).toEqual([
        ["one", "settled"],
        ["two", "sent"],
      ])
      tell({ items: [userItem(0, "one")] })
      expect(phasesAt(chat, moved)).toEqual([["two", "sent"]])
      expect(phasesAt(chat, context)).toEqual([])
    })

    it("puts the words of one that failed back in the box there", async () => {
      let move = (_to: string) => {}
      const setup = open("s1", {
        sends: () => {
          move("other")
          throw withReturned(new Error("It didn't land."), "came back")
        },
      })
      move = setup.move
      setup.commands.setChatDraft("01", "the message")
      await expect(setup.commands.sendChat(key, "the message", null)).rejects.toThrow(
        "It didn't land.",
      )
      expect(chatDraftOf(setup.chat.store.getSnapshot().drafts, moved, "01")).toBe(
        "came back\nthe message",
      )
      expect(phasesAt(setup.chat, moved)).toEqual([])
    })

    it("hands the queued words back there on a Stop it moved during", async () => {
      let move = (_to: string) => {}
      const setup = open("s1", {
        interrupt: async () => {
          move("other")
          return { words: "in the agent's box" }
        },
      })
      move = setup.move
      const { queued } = await setup.two()
      await setup.commands.stopChat(key)
      await expect(queued).resolves.toBe(false)
      expect(chatDraftOf(setup.chat.store.getSnapshot().drafts, moved, "01")).toBe(
        "in the agent's box\ntwo",
      )
    })

    it("puts nothing back once it closed", async () => {
      let close = () => {}
      const setup = open("s1", {
        sends: () => {
          close()
          throw withReturned(new Error("It didn't land."), "came back")
        },
      })
      close = setup.close
      setup.commands.setChatDraft("01", "the message")
      await expect(setup.commands.sendChat(key, "the message", null)).rejects.toThrow(
        "It didn't land.",
      )
      expect(setup.chat.store.getSnapshot().drafts).toEqual({})
    })
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

describe("a prompt whose answer the link lost", () => {
  // The first send's call fails as the link drops under it, the runner going on with it; the
  // rest go. `before` runs as the link comes back, ahead of the failure: a resync that already
  // carries the receipt.
  const losing = (before?: (setup: ReturnType<typeof open>) => void) => {
    let calls = 0
    let setup: ReturnType<typeof open> | undefined = undefined
    setup = open("s1", {
      sends: () => {
        calls += 1
        if (calls > 1) return
        before?.(setup!)
        throw new InDoubt()
      },
    })
    return setup
  }

  // No receipt ever follows these: no wait can tell whether they went.
  // A shell command goes back after the words behind it, as `joinDraft` keeps words out of
  // its lines.
  for (const [what, words, asked, back] of [
    ["a shell command", "!npm run migrate", false, "next\n!npm run migrate"],
    [
      "words that answer a question set aside",
      "Use the other table",
      true,
      "Use the other table\nnext",
    ],
  ] as const)
    it(`comes back at once, said as may have gone, for ${what}, with what was queued behind`, async () => {
      const setup = losing()
      const { commands, sent, phases, draft, tell } = setup
      if (asked)
        tell({
          requests: [
            {
              id: "q1",
              kind: "question",
              tool: "AskUserQuestion",
              subject: null,
              choices: [],
              subagent: false,
              dialog: { type: "questions", id: "q1:d", chat: "prompt", questions: [] },
              answered: false,
              askedAt: 0,
            },
          ],
        })
      commands.setChatDraft("01", words)
      const first = commands.sendChat(key, words, null)
      const second = commands.sendChat(key, "next", null)
      await expect(first).rejects.toThrow(inDoubtNote)
      await expect(second).resolves.toBe(false)
      expect(phases()).toEqual([])
      expect(draft()).toBe(back)
      expect(sent).toEqual([words])
    })

  it("stays on its way, holding what was queued behind it, until its receipt says it went", async () => {
    const { commands, sent, phases, draft, receipt, tell } = losing()
    commands.setChatDraft("01", "one")
    const first = commands.sendChat(key, "one", null)
    const second = commands.sendChat(key, "two", null)
    let went: boolean | undefined
    void first.then((result) => (went = result))
    await vi.waitFor(() =>
      expect(phases()).toEqual([
        ["one", "sent"],
        ["two", "queued"],
      ]),
    )
    // Neither refused nor gone: not in the box, and its promise still waits.
    expect(draft()).toBe("")
    expect(went).toBeUndefined()
    expect(sent).toEqual(["one"])
    // Back after the reconnect: the runner took it.
    tell({ prompts: [receipt(0, "pending")] })
    await expect(first).resolves.toBe(true)
    tell({ prompts: [receipt(0, "settled", 0)] })
    await expect(second).resolves.toBe(true)
    expect(sent).toEqual(["one", "two"])
  })

  it("goes by a receipt that came with the reconnect, ahead of the failure", async () => {
    const { commands, phases } = losing(({ tell, receipt }) =>
      tell({ prompts: [receipt(0, "pending")] }),
    )
    await expect(commands.sendChat(key, "one", null)).resolves.toBe(true)
    expect(phases()).toEqual([["one", "sent"]])
  })

  it("comes back to the box with what was queued behind it, in order, once no receipt shows", async () => {
    vi.useFakeTimers()
    const { commands, sent, phases, draft } = losing()
    commands.setChatDraft("01", "one")
    const first = commands.sendChat(key, "one", null)
    const second = commands.sendChat(key, "two", null)
    void first.catch(() => {})
    await vi.advanceTimersByTimeAsync(unseenMs - 1)
    expect(phases()).toEqual([
      ["one", "sent"],
      ["two", "queued"],
    ])
    await vi.advanceTimersByTimeAsync(1)
    await expect(first).rejects.toThrow(inDoubtNote)
    await expect(second).resolves.toBe(false)
    expect(phases()).toEqual([])
    expect(draft()).toBe("one\ntwo")
    expect(sent).toEqual(["one"])
  })

  it("comes back to the box once its agent moved on to another session with no receipt", async () => {
    const { commands, draft, tell } = losing()
    commands.setChatDraft("01", "one")
    const first = commands.sendChat(key, "one", null)
    void first.catch(() => {})
    await vi.waitFor(() => expect(draft()).toBe(""))
    tell({ session: "s2" })
    await expect(first).rejects.toThrow(inDoubtNote)
    expect(draft()).toBe("one")
  })
})

describe("a Stop whose answer the link lost", () => {
  it("puts back the chat's prompt its receipt says it withdrew, whenever that shows", async () => {
    for (const when of ["during", "after"] as const) {
      let tellWithdrawn = () => {}
      const setup = open("s1", {
        interrupt: async () => {
          if (when === "during") tellWithdrawn()
          throw new InDoubt()
        },
      })
      const { commands, receipt, tell, draft, phases, two } = setup
      tellWithdrawn = () => tell({ prompts: [receipt(0, "withdrawn")] })
      // eslint-disable-next-line no-await-in-loop -- One case after the other.
      const { queued } = await two()
      commands.setChatDraft("01", "typed meanwhile")
      // eslint-disable-next-line no-await-in-loop -- As above.
      await expect(commands.stopChat(key)).rejects.toThrow(InDoubt)
      // eslint-disable-next-line no-await-in-loop -- As above.
      await expect(queued).resolves.toBe(false)
      if (when === "after") tellWithdrawn()
      expect(draft(), when).toBe("one\ntwo\ntyped meanwhile")
      expect(phases(), when).toEqual([])
    }
  })

  it("puts nothing back twice where the Stop's answer came", async () => {
    const setup = open("s1", {
      interrupt: async () => {
        setup.tell({ prompts: [setup.receipt(0, "withdrawn")] })
        return { words: "one" }
      },
    })
    const { commands, draft, phases, two } = setup
    await two()
    await commands.stopChat(key)
    expect(draft()).toBe("one\ntwo")
    expect(phases()).toEqual([])
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
