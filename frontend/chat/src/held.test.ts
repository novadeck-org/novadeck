import { noConversation, type ChatItem, type Conversation } from "@novadeck/core/conversation"
import { createStore } from "@novadeck/core/store"
import { refusing } from "@novadeck/core/testing"
import type { AgentStatus } from "@novadeck/core/types"
import { render } from "@novadeck/test-kit/render"
import { Shown } from "@novadeck/toolkit/shown"
import { act, createElement } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { ChatView } from "./ChatView"
import { holdAfterMs, Holding, useHeldSnapshot } from "./held"
import { context, describe, expect, it } from "./test"

// A store that counts who listens to it.
const counted = (value: number) => {
  const store = createStore(value)
  let listening = 0
  return {
    store,
    listening: () => listening,
    subscribe: (listener: () => void) => {
      listening += 1
      const stop = store.subscribe(listener)
      return () => {
        listening -= 1
        stop()
      }
    },
  }
}

// What reads the store in a chat that holds or not, noting each value it draws.
const reader = (source: ReturnType<typeof counted>, shown: boolean) => {
  const drawn: number[] = []
  const Reader = (): null => {
    drawn.push(useHeldSnapshot(source.subscribe, source.store.getSnapshot))
    return null
  }
  const element = (inSight: boolean) =>
    createElement(Holding, { value: !inSight }, createElement(Reader))
  const { rerender } = render(element(shown))
  return { drawn, show: (inSight: boolean) => rerender(element(inSight)) }
}

describe("a store read in a chat that holds", () => {
  it("is followed while in sight", () => {
    const source = counted(1)
    const { drawn } = reader(source, true)
    act(() => void source.store.update(() => 2))
    expect(drawn.at(-1)).toBe(2)
    expect(source.listening()).toBe(1)
  })

  it("holds at what it last drew while out of sight, and no one listens", () => {
    const source = counted(1)
    const { drawn, show } = reader(source, true)
    show(false)
    const before = drawn.length
    act(() => void source.store.update(() => 2))
    act(() => void source.store.update(() => 3))
    expect(drawn.length).toBe(before)
    expect(source.listening()).toBe(0)
  })

  it("draws what came meanwhile once back in sight", () => {
    const source = counted(1)
    const { drawn, show } = reader(source, true)
    show(false)
    act(() => void source.store.update(() => 3))
    show(true)
    expect(drawn.at(-1)).toBe(3)
    expect(source.listening()).toBe(1)
  })

  it("reads it once as it mounts out of sight, and holds at that", () => {
    const source = counted(1)
    const { drawn, show } = reader(source, false)
    expect(drawn.at(-1)).toBe(1)
    act(() => void source.store.update(() => 2))
    // Drawn again for its own reasons, it shows what it drew.
    show(false)
    expect(drawn.at(-1)).toBe(1)
    expect(source.listening()).toBe(0)
    show(true)
    expect(drawn.at(-1)).toBe(2)
  })
})

const said = (id: string, text: string): ChatItem => ({
  id,
  at: null,
  role: "assistant",
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

const working: AgentStatus = { working: true } as AgentStatus

describe("a chat out of sight", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // The chat of an agent, in sight or not, and what it's handed of its agent's status.
  const open = (shown: boolean) => {
    const conversation = createStore<Conversation>({
      ...noConversation,
      agent: "claude",
      session: "s",
      loaded: true,
      items: [said("s:0", "First words")],
    })
    const element = (inSight: boolean, agent: AgentStatus | undefined) =>
      createElement(
        Shown,
        { value: inSight },
        createElement(ChatView, {
          conversation,
          terminalName: "T",
          program: "claude",
          agent,
          compact: false,
          draft: "",
          onDraft: () => {},
          replyTo: null,
          onReplyTo: () => {},
          sending: [],
          attachments: [],
          onRestore: () => {},
          onDetach: () => {},
          onSend: async () => true,
          onInterrupt: async () => {},
          onClearBox: async () => {},
          onAnswer: async () => {},
          onAnswerInTerminal: () => {},
          onWordsLost: () => {},
          focusInput: false,
          onInputFocused: () => {},
          refused: refusing(),
        }),
      )
    const { container, rerender } = render(element(shown, undefined))
    return {
      container,
      conversation,
      show: (inSight: boolean, agent?: AgentStatus) => rerender(element(inSight, agent)),
    }
  }
  const text = (container: HTMLElement) => container.querySelector(".chat-thread")?.textContent
  const workingLine = (container: HTMLElement) =>
    container.querySelector(".chat-running[data-working]")
  const more = (conversation: ReturnType<typeof open>["conversation"]) =>
    act(
      () =>
        void conversation.update((now) => ({
          ...now,
          items: [...now.items, said("s:1", "More words")],
        })),
    )
  // Out of sight long enough to hold.
  const leave = (show: (inSight: boolean) => void) => {
    show(false)
    act(() => void vi.advanceTimersByTime(holdAfterMs))
  }

  it("keeps drawing a while after it leaves sight, as what the person did there finishes", () => {
    const { container, conversation, show } = open(true)
    show(false)
    act(() => void vi.advanceTimersByTime(holdAfterMs - 1))
    more(conversation)
    expect(text(container)).toContain("More words")
  })

  it("draws nothing its agent says meanwhile, and all of it once back in sight", () => {
    const { container, conversation, show } = open(true)
    leave(show)
    more(conversation)
    expect(text(container)).toContain("First words")
    expect(text(container)).not.toContain("More words")
    show(true)
    expect(text(container)).toContain("More words")
  })

  it("draws nothing of what the app hands it as its agent works until back in sight", () => {
    const { container, show } = open(true)
    leave(show)
    show(false, working)
    expect(workingLine(container)).toBeNull()
    show(true, working)
    expect(workingLine(container)).not.toBeNull()
  })

  it("holds at once as it mounts out of sight, showing what its conversation held then", () => {
    const { container, conversation, show } = open(false)
    expect(text(container)).toContain("First words")
    more(conversation)
    expect(text(container)).not.toContain("More words")
    show(true)
    expect(text(container)).toContain("More words")
  })

  context("back in sight after a long backlog", () => {
    const rows = (container: HTMLElement): string[] =>
      [...container.querySelectorAll(".chat-thread > .chat-message")].map(
        (row) => row.textContent ?? "",
      )
    const backlog = (
      conversation: ReturnType<typeof open>["conversation"],
      from: number,
      count: number,
    ) =>
      act(
        () =>
          void conversation.update((now) => ({
            ...now,
            items: [
              ...now.items,
              ...Array.from({ length: count }, (_, at) =>
                said(`s:${from + at}`, `Step ${from + at}`),
              ),
            ],
          })),
      )
    // Each step of the window once the one before drew.
    const idle = () => {
      for (let step = 0; step < 6; step += 1) act(() => void vi.runAllTimers())
    }

    it("draws only its latest blocks at first, and the earlier ones once the page is idle", () => {
      const { container, conversation, show } = open(true)
      backlog(conversation, 1, 40)
      idle()
      expect(rows(container)).toHaveLength(41)
      leave(show)
      backlog(conversation, 41, 30)
      show(true)
      expect(rows(container)).toHaveLength(10)
      expect(rows(container).at(-1)).toContain("Step 70")
      idle()
      expect(rows(container)).toHaveLength(60)
      expect(rows(container).at(-1)).toContain("Step 70")
    })

    it("draws a few blocks that came meanwhile among those it showed", () => {
      const { container, conversation, show } = open(true)
      leave(show)
      backlog(conversation, 1, 3)
      show(true)
      expect(rows(container)).toHaveLength(4)
      expect(rows(container)[0]).toContain("First words")
    })
  })
})
