import { noConversation, type Conversation, type Conversations } from "@novadeck/core/conversation"
import { emptiness } from "@novadeck/core/conversation/emptiness"
import { createStore } from "@novadeck/core/store"
import { describe, expect, it, vi } from "vitest"

import { createEmptyChats } from "./emptiness"
import type { DemoAction, DemoActionContext } from "./types"

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }

// A demo agent with a session and a few items, which the panel's states set aside.
const talking: Conversation = {
  ...noConversation,
  agent: "claude",
  session: "s1",
  loaded: true,
  records: { state: "read", lines: 1, unread: 0 },
  rest: true,
  items: [
    {
      id: "s1:0",
      at: 1,
      role: "assistant",
      kind: "text",
      text: "Hello",
      truncated: false,
      tool: null,
      call: null,
      author: null,
      run: null,
      outcome: null,
      scripted: false,
      interrupted: false,
      ring: null,
    },
  ],
}

const play = (actions: readonly DemoAction[], label: string, selected = true) => {
  const note = vi.fn<(text: string) => void>()
  void actions
    .find((action) => action.label === label)!
    .run({ selected: () => (selected ? key : undefined), note } as unknown as DemoActionContext)
  return note
}

describe("the debug panel's chat with nothing to show", () => {
  const setup = () => {
    const base = createStore<Conversation>(talking)
    const empty = createEmptyChats()
    const view = empty
      .wrap({ conversation: () => base } as unknown as Conversations)
      .conversation(key)
    return { empty, view, base }
  }

  it("leaves the agent's own conversation alone until a state is set", () => {
    const { view } = setup()
    expect(view.getSnapshot()).toBe(talking)
  })

  it("sets each state the chat tells apart, and gives the conversation back", () => {
    const { empty, view } = setup()
    const changed = vi.fn<() => void>()
    view.subscribe(changed)
    const verdict = (label: string) => {
      play(empty.actions, label)
      expect(view.getSnapshot().items).toEqual([])
      return emptiness(view.getSnapshot())
    }
    expect(verdict("Empty, proven")).toEqual({ state: "empty" })
    expect(verdict("Transcript not found")).toEqual({ state: "unproven", reason: "lost" })
    expect(verdict("Records unreadable")).toEqual({ state: "unproven", reason: "unread" })
    expect(verdict("Turn with no records")).toEqual({ state: "unproven", reason: "turned" })
    expect(verdict("Dialog on its screen")).toEqual({ state: "unproven", reason: "screen" })
    expect(view.getSnapshot().screen?.rows.length).toBeGreaterThan(0)
    expect(verdict("Waiting on the screen")).toEqual({ state: "loading" })
    expect(changed).toHaveBeenCalledTimes(6)
    play(empty.actions, "Back to normal")
    expect(view.getSnapshot()).toBe(talking)
  })

  it("asks for a terminal first", () => {
    const { empty } = setup()
    expect(play(empty.actions, "Empty, proven", false)).toHaveBeenCalledWith(
      "Select a terminal first.",
    )
  })
})
