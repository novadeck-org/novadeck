import { noConversation, type Conversation } from "@novadeck/core/conversation"
import { createStore } from "@novadeck/core/store"
import { refusing } from "@novadeck/core/testing"
import type { AgentStatus } from "@novadeck/core/types"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { ChatView } from "./ChatView"
import { describe, expect, it } from "./test"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const user = (at: number | null) => ({
  id: "s:0",
  at,
  role: "user" as const,
  kind: "text" as const,
  text: "Fix it",
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

// The chat of an agent that works, which a Stop reaches through `interrupt`.
const open = (agent: AgentStatus | undefined, at: number | null = null) => {
  const interrupt = vi.fn<() => Promise<void>>(async () => {})
  const conversation = createStore<Conversation>({
    ...noConversation,
    agent: "claude",
    session: "s",
    loaded: true,
    items: [user(at)],
  })
  const { container, unmount } = render(
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
      onInterrupt: interrupt,
      onClearBox: async () => {},
      onAnswer: async () => {},
      onAnswerInTerminal: () => {},
      onWordsLost: () => {},
      focusInput: false,
      onInputFocused: () => {},
      refused: refusing(),
    }),
  )
  unmounts.push(unmount)
  return { container, interrupt }
}

const stopKey = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('.chat-running button[aria-label="Stop"]')

describe("the working line", () => {
  it("is pinned with the log's end while the agent works, holding Stop", () => {
    const { container } = open({ working: true })
    const line = container.querySelector(".chat-thread > .chat-running[data-working]")
    expect(line?.querySelector(".chat-status")?.textContent).toBe("Working")
    expect(stopKey(container)?.textContent).toBe("escstop")
    expect(stopKey(container)?.querySelector("kbd")?.textContent).toBe("esc")
    // The prompt keeps no Stop.
    expect(container.querySelector('.chat-composer button[aria-label="Stop"]')).toBeNull()
  })

  it("has no Stop once the agent rests", () => {
    const { container } = open({ working: false })
    expect(stopKey(container)).toBeNull()
    expect(container.querySelector(".chat-running[data-working]")).toBeNull()
  })

  it("stops the agent from its key", async () => {
    const { container, interrupt } = open({ working: true })
    await act(async () => void stopKey(container)!.click())
    expect(interrupt).toHaveBeenCalledOnce()
  })

  it("stops the agent at Esc from the box, and from the log", async () => {
    const { container, interrupt } = open({ working: true })
    const esc = (target: Element) =>
      act(async () => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        )
      })
    await esc(container.querySelector(".chat-input")!)
    await esc(container.querySelector(".chat-scroll")!)
    expect(interrupt).toHaveBeenCalledTimes(2)
  })

  it("leaves Esc alone while the agent rests", async () => {
    const { container, interrupt } = open({ working: false })
    await act(async () => {
      container
        .querySelector(".chat-input")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it("shows how long the turn has run, where its prompt has a time", () => {
    const { container } = open({ working: true }, Date.now() - 72_000)
    expect(container.querySelector(".chat-status-end .chat-fact")?.textContent).toMatch(/^1m 1\ds$/)
    const bare = open({ working: true }).container
    expect(bare.querySelector(".chat-status-end .chat-fact")).toBeNull()
  })

  it("says why a Stop didn't go over the box", async () => {
    const { container, interrupt } = open({ working: true })
    interrupt.mockRejectedValueOnce(new Error("The runner is offline."))
    await act(async () => void stopKey(container)!.click())
    expect(container.querySelector(".chat-composer .chat-error")?.textContent).toContain(
      "The runner is offline.",
    )
  })
})
