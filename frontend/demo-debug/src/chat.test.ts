import { noConversation, SettleInTerminal, type Conversations } from "@novadeck/core/conversation"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createChatFailures, createChatPictures, slowPictureMs } from "./chat"

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }

const inner = (sent: string[] = []): Conversations => ({
  conversation: () => ({ getSnapshot: () => noConversation, subscribe: () => () => {} }),
  send: async (_key, text) => void sent.push(text),
  interrupt: async () => ({ words: null }),
  answer: async () => {},
  refused: () => false,
})

describe("the debug panel's chat failures", () => {
  it("hands a send's options to the conversations it wraps", async () => {
    const given: unknown[] = []
    const conversations = createChatFailures().wrap({
      ...inner(),
      send: async (_key, _text, options) => void given.push(options),
    })
    await conversations.send(key, "continue", { automatic: true })
    expect(given).toEqual([{ automatic: true }])
  })

  it("fail the next send once, as the runner would, then let sends through", async () => {
    const sent: string[] = []
    const chat = createChatFailures()
    const conversations = chat.wrap(inner(sent))
    const draft = chat.actions.find((action) => action.label.includes("Draft"))!
    await draft.run({} as never)
    await expect(conversations.send(key, "one")).rejects.toThrow("Clear it above")
    await conversations.send(key, "two")
    expect(sent).toEqual(["two"])
    const ringing = chat.actions.find((action) => action.label.includes("Doorbell"))!
    await ringing.run({} as never)
    await expect(conversations.send(key, "three")).rejects.toThrow("in a moment")
  })

  it("arm each other way a send is turned away, with the terminal offered only where it settles there", async () => {
    const chat = createChatFailures()
    const conversations = chat.wrap(inner())
    const armed = async (label: string) => {
      await chat.actions.find((action) => action.label === label)!.run({} as never)
      return conversations.send(key, "hi").catch((error: unknown) => error)
    }
    const agent = await armed("No agent running")
    expect(agent).toBeInstanceOf(SettleInTerminal)
    expect(agent).toHaveProperty("message", expect.stringContaining("No agent is running"))
    const pending = await armed("Request waiting")
    expect(pending).not.toBeInstanceOf(SettleInTerminal)
    expect(pending).toHaveProperty("message", expect.stringContaining("waiting for your answer"))
    const words = await armed("Question takes only words")
    expect(words).not.toBeInstanceOf(SettleInTerminal)
    expect(words).toHaveProperty("message", expect.stringContaining("Remove the images"))
    const paste = await armed("Screen not ready")
    expect(paste).not.toBeInstanceOf(SettleInTerminal)
    expect(paste).toHaveProperty("message", expect.stringContaining("in a moment"))

    // As an older runner says nothing of why: the terminal is where to look.
    const none = await armed("No reason given")
    expect(none).toBeInstanceOf(SettleInTerminal)
    expect(none).toHaveProperty("message", expect.stringContaining("Check its terminal"))
  })

  it("arm the next Stop to leave the queued words in the box, once", async () => {
    const chat = createChatFailures()
    const conversations = chat.wrap(inner())
    await chat.actions.find((action) => action.label.includes("Stop"))!.run({} as never)
    const failure = await conversations.interrupt(key).catch((error: unknown) => error)
    // The next message sees to them: nothing to settle in the terminal.
    expect(failure).not.toBeInstanceOf(SettleInTerminal)
    expect(failure).toHaveProperty("message", expect.stringContaining("still in the agent's box"))
    expect(await conversations.interrupt(key)).toEqual({ words: null })
  })

  it("arm the next Stop to meet a request waiting, saying to answer it first", async () => {
    const chat = createChatFailures()
    const conversations = chat.wrap(inner())
    await chat.actions.find((action) => action.label === "Stop: request waiting")!.run({} as never)
    const failure = await conversations.interrupt(key).catch((error: unknown) => error)
    expect(failure).not.toBeInstanceOf(SettleInTerminal)
    expect(failure).toHaveProperty("message", expect.stringContaining("then stop it"))
    expect(await conversations.interrupt(key)).toEqual({ words: null })
  })
})

describe("a request armed as waiting, under the person's own Send or Stop", () => {
  const asking = (sent: string[], stopped: unknown[]): Conversations => ({
    ...inner(sent),
    conversation: () => ({
      getSnapshot: () => ({
        ...noConversation,
        requests: [
          {
            id: "r1",
            kind: "question",
            tool: "AskUserQuestion",
            subject: null,
            choices: [],
            subagent: false,
            dialog: { type: "questions", id: "d1", chat: "prompt", questions: [] },
            answered: false,
            askedAt: 0,
          },
        ],
      }),
      subscribe: () => () => {},
    }),
    interrupt: async (_key, options) => {
      stopped.push(options)
      return { words: null }
    },
  })
  const arm = async (chat: ReturnType<typeof createChatFailures>, label: string) =>
    chat.actions.find((action) => action.label === label)!.run({} as never)

  it("gives way where the agent asks a question, which the send sets aside", async () => {
    const sent: string[] = []
    const stopped: unknown[] = []
    const chat = createChatFailures()
    const conversations = chat.wrap(asking(sent, stopped))
    await arm(chat, "Request waiting")
    await conversations.send(key, "Do this instead", { setAside: ["r1"] })
    expect(sent).toEqual(["Do this instead"])
    await arm(chat, "Stop: request waiting")
    await conversations.interrupt(key, { setAside: ["r1"] })
    expect(stopped).toEqual([{ setAside: ["r1"] }])
  })

  it("refuses as ever without setAside, as for a permission", async () => {
    const chat = createChatFailures()
    const conversations = chat.wrap(asking([], []))
    await arm(chat, "Request waiting")
    await expect(conversations.send(key, "hi")).rejects.toThrow("waiting for your answer")
    await arm(chat, "Stop: request waiting")
    await expect(conversations.interrupt(key)).rejects.toThrow("Answer it first, then stop it")
  })

  it("refuses a send with setAside where no question waits", async () => {
    const chat = createChatFailures()
    const conversations = chat.wrap(inner())
    await arm(chat, "Request waiting")
    await expect(conversations.send(key, "hi", { setAside: ["r1"] })).rejects.toThrow(
      "waiting for your answer",
    )
  })
})

describe("the debug panel's pictures of recorded prompts", () => {
  afterEach(() => vi.useRealTimers())
  const image = { offset: 1, index: 0, mime: null }
  const backend = (): Conversations => ({
    ...inner(),
    image: async () => "data:image/png;base64,AAAA",
  })

  it("come as the backend finds them until a way is armed, and again once it is found again", async () => {
    const pictures = createChatPictures()
    const conversations = pictures.wrap(backend())
    const arm = (label: string) =>
      pictures.actions.find((action) => action.label === label)!.run({} as never)
    await expect(conversations.image!(key, image)).resolves.toBe("data:image/png;base64,AAAA")
    await arm("Pictures gone")
    await expect(conversations.image!(key, image)).resolves.toBeNull()
    await arm("Pictures unreachable")
    await expect(conversations.image!(key, image)).rejects.toThrow("offline")
    await arm("Pictures found")
    await expect(conversations.image!(key, image)).resolves.toBe("data:image/png;base64,AAAA")
  })

  it("take a while when armed slow", async () => {
    vi.useFakeTimers()
    const pictures = createChatPictures()
    const conversations = pictures.wrap(backend())
    await pictures.actions.find((action) => action.label === "Pictures slow")!.run({} as never)
    let picture: string | null | undefined
    void conversations.image!(key, image).then((found) => (picture = found))
    await vi.advanceTimersByTimeAsync(slowPictureMs - 1)
    expect(picture).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(picture).toBe("data:image/png;base64,AAAA")
  })

  it("leave conversations that find no pictures as they are", () => {
    const bare = inner()
    expect(createChatPictures().wrap(bare)).toBe(bare)
  })
})
