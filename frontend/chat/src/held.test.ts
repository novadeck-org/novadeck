import { noConversation, type ChatItem, type Conversation } from "@novadeck/core/conversation"
import { createStore } from "@novadeck/core/store"
import { refusing } from "@novadeck/core/testing"
import type { AgentStatus } from "@novadeck/core/types"
import { render } from "@novadeck/test-kit/render"
import { Shown } from "@novadeck/toolkit/shown"
import { act, createElement } from "react"

import { ChatView } from "./ChatView"
import { useHeldSnapshot } from "./held"
import { describe, expect, it } from "./test"

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

// What reads the store, in sight or not, noting each value it draws.
const reader = (source: ReturnType<typeof counted>, shown: boolean) => {
  const drawn: number[] = []
  const Reader = (): null => {
    drawn.push(useHeldSnapshot(source.subscribe, source.store.getSnapshot))
    return null
  }
  const element = (inSight: boolean) =>
    createElement(Shown, { value: inSight }, createElement(Reader))
  const { rerender } = render(element(shown))
  return { drawn, show: (inSight: boolean) => rerender(element(inSight)) }
}

describe("a store read out of sight", () => {
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

  it("draws nothing its agent says meanwhile, and all of it once back in sight", () => {
    const { container, conversation, show } = open(true)
    show(false)
    act(
      () =>
        void conversation.update((now) => ({
          ...now,
          items: [...now.items, said("s:1", "More words")],
        })),
    )
    expect(text(container)).toContain("First words")
    expect(text(container)).not.toContain("More words")
    show(true)
    expect(text(container)).toContain("More words")
  })

  it("draws nothing of what the app hands it as its agent works until back in sight", () => {
    const { container, show } = open(true)
    show(false)
    show(false, working)
    expect(workingLine(container)).toBeNull()
    show(true, working)
    expect(workingLine(container)).not.toBeNull()
  })

  it("shows what its conversation holds as it mounts out of sight", () => {
    const { container } = open(false)
    expect(text(container)).toContain("First words")
  })
})
