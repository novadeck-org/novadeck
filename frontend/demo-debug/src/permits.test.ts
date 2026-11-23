import { noConversation, type Conversation, type Conversations } from "@novadeck/core/conversation"
import { createStore } from "@novadeck/core/store"
import type { TerminalKey } from "@novadeck/core/types"
import { afterEach, beforeEach, vi } from "vitest"

import { createChatPermits } from "./permits"
import { describe, expect, it } from "./test"

const key: TerminalKey = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("the debug panel's shipping permits", () => {
  const setup = () => {
    const base = createStore<Conversation>(noConversation)
    const permits = createChatPermits()
    const chat = permits.wrap({ conversation: () => base } as unknown as Conversations)
    const run = (label: string) =>
      permits.actions
        .find((action) => action.label === label)!
        .run({ selected: () => key, note: vi.fn<(text: string) => void>() } as never)
    return { chat, run, actions: permits.actions }
  }

  it("hints what each action shows", () => {
    expect(setup().actions.every((action) => action.hint.length > 0)).toBe(true)
  })

  it("gives the selected chat each kind: by words or by card, unused or used", () => {
    const { chat, run } = setup()
    run("Permit by words, not used")
    run("Permit by card, not used")
    run("Permit by words, used")
    run("Permit by card, used")

    const { permits } = chat.conversation(key).getSnapshot()
    expect(permits.map(({ quote, usedAt }) => [quote !== null, usedAt !== null])).toEqual([
      [true, false],
      [false, false],
      [true, true],
      [false, true],
    ])
  })

  it("takes a permit back after the moment a call takes, and fails once where armed", async () => {
    const { chat, run } = setup()
    run("Permit by card, not used")
    const view = chat.conversation(key)
    const [permit] = view.getSnapshot().permits

    run("Next Take back fails")
    const failed = chat.takeBack!(key, permit!.id)
    const refused = expect(failed).rejects.toThrow("Couldn't take it back")
    await vi.advanceTimersByTimeAsync(300)
    await refused
    expect(view.getSnapshot().permits).toHaveLength(1)

    const taken = chat.takeBack!(key, permit!.id)
    await vi.advanceTimersByTimeAsync(300)
    await taken
    expect(view.getSnapshot().permits).toEqual([])
  })
})
