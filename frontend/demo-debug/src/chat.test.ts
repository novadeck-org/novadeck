import { noConversation, SettleInTerminal, type Conversations } from "@novadeck/core/conversation"
import { describe, expect, it } from "vitest"

import { createDebugChat } from "./chat"

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }

const inner = (sent: string[] = []): Conversations => ({
  conversation: () => ({ getSnapshot: () => noConversation, subscribe: () => () => {} }),
  send: async (_key, text) => void sent.push(text),
  interrupt: async () => null,
  answer: async () => {},
  refused: () => false,
})

describe("the debug panel's chat failures", () => {
  it("fail the next send once, as the runner would, then let sends through", async () => {
    const sent: string[] = []
    const chat = createDebugChat()
    const conversations = chat.wrap(inner(sent))
    const draft = chat.actions.find((action) => action.label.includes("Draft"))!
    await draft.run({} as never)
    await expect(conversations.send(key, "one")).rejects.toBeInstanceOf(SettleInTerminal)
    await conversations.send(key, "two")
    expect(sent).toEqual(["two"])
    const ringing = chat.actions.find((action) => action.label.includes("Doorbell"))!
    await ringing.run({} as never)
    await expect(conversations.send(key, "three")).rejects.toThrow("in a moment")
  })

  it("arm each other way a send is turned away, with the terminal offered only where it settles there", async () => {
    const chat = createDebugChat()
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
    const paste = await armed("Screen not ready")
    expect(paste).not.toBeInstanceOf(SettleInTerminal)
    expect(paste).toHaveProperty("message", expect.stringContaining("in a moment"))

    // As an older runner says nothing of why: the terminal is where to look.
    const none = await armed("No reason given")
    expect(none).toBeInstanceOf(SettleInTerminal)
    expect(none).toHaveProperty("message", expect.stringContaining("Check its terminal"))
  })

  it("arm the next Stop to leave the queued words in the box, once", async () => {
    const chat = createDebugChat()
    const conversations = chat.wrap(inner())
    await chat.actions.find((action) => action.label.includes("Stop"))!.run({} as never)
    const failure = await conversations.interrupt(key).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SettleInTerminal)
    expect(failure).toHaveProperty("message", expect.stringContaining("still in the agent's box"))
    expect(await conversations.interrupt(key)).toBeNull()
  })

  it("arm the next Stop to meet a request waiting, saying to answer it first", async () => {
    const chat = createDebugChat()
    const conversations = chat.wrap(inner())
    await chat.actions.find((action) => action.label === "Stop: request waiting")!.run({} as never)
    const failure = await conversations.interrupt(key).catch((error: unknown) => error)
    expect(failure).not.toBeInstanceOf(SettleInTerminal)
    expect(failure).toHaveProperty("message", expect.stringContaining("then stop it"))
    expect(await conversations.interrupt(key)).toBeNull()
  })
})
