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
const open = (
  agent: AgentStatus | undefined,
  at: number | null = null,
  harness: "claude" | "codex" | "antigravity" = "claude",
) => {
  const interrupt = vi.fn<() => Promise<void>>(async () => {})
  const conversation = createStore<Conversation>({
    ...noConversation,
    agent: harness,
    session: "s",
    loaded: true,
    items: [user(at)],
  })
  const { container, unmount } = render(
    createElement(ChatView, {
      conversation,
      terminalName: "T",
      program: harness,
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
  it("is the log's last row while the agent works, holding Stop, and pinned to nothing", () => {
    const { container } = open({ working: true })
    const line = container.querySelector(".chat-thread > .chat-running[data-working]")
    expect(line?.hasAttribute("data-pinned")).toBe(false)
    expect(line).toBe(container.querySelector(".chat-thread")!.lastElementChild)
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

describe("the background shells", () => {
  const harnesses = ["claude", "codex", "antigravity"] as const
  const shell = (n: number, command: string, minutes: number, exit = false) => ({
    id: `${n}`,
    command,
    since: Date.now() - minutes * 60_000,
    exit: exit ? { at: Date.now(), code: 0 } : null,
  })
  const lines = (container: HTMLElement) =>
    [...container.querySelectorAll(".chat-shells .chat-shell")].map((line) => line.textContent)
  const commands = ["pnpm dev --filter storefront", "tail -f logs/api.log", "docker compose up db"]

  it("shows nothing for an agent with no shell", () => {
    const { container } = open({ working: true })
    expect(container.querySelector(".chat-shells")).toBeNull()
  })

  it.each(harnesses)("shows a running %s shell under the working line", (harness) => {
    const { container } = open(
      { working: true, shells: [shell(1, commands[0]!, 4)] },
      null,
      harness,
    )
    const running = container.querySelector(".chat-thread > .chat-running")!
    expect(running.hasAttribute("data-pinned")).toBe(false)
    expect(running.children[0]?.className).toBe("chat-status")
    expect(running.querySelector(".chat-shells")).not.toBeNull()
    const line = running.querySelector(".chat-shell")!
    expect(line.querySelector(".chat-shell-command")?.textContent).toBe(commands[0])
    // Its clock keeps where the chat is narrow, and is for the eye.
    const clock = line.querySelector(".chat-fact")!
    expect(clock.textContent).toMatch(/^4m( \d+s)?$/)
    expect(clock.getAttribute("aria-hidden")).toBe("true")
    expect(clock.hasAttribute("data-keep")).toBe(true)
    expect(clock.hasAttribute("data-live")).toBe(true)
    // One spinner: the shell has none.
    expect(running.querySelectorAll(".chat-spin")).toHaveLength(1)
  })

  it.each(harnesses)("stays after the turn, for an idle %s agent", (harness) => {
    const { container } = open(
      { working: false, shells: [shell(1, commands[0]!, 4)] },
      null,
      harness,
    )
    expect(container.querySelector(".chat-status")).toBeNull()
    expect(container.querySelector(".chat-running")).not.toBeNull()
    expect(container.querySelector(".chat-running[data-working]")).toBeNull()
    expect(stopKey(container)).toBeNull()
    expect(lines(container)).toHaveLength(1)
  })

  it("lists two shells, oldest first", () => {
    const { container } = open({
      working: false,
      shells: [shell(1, commands[0]!, 9), shell(2, commands[1]!, 3)],
    })
    expect(lines(container)).toEqual([
      expect.stringContaining(commands[0]!),
      expect.stringContaining(commands[1]!),
    ])
    expect(container.querySelector(".chat-shell-toggle")).toBeNull()
  })

  it("drops a shell that ended", () => {
    const { container } = open({
      working: false,
      shells: [shell(1, commands[0]!, 9, true), shell(2, commands[1]!, 3)],
    })
    expect(lines(container)).toEqual([expect.stringContaining(commands[1]!)])
    const gone = open({ working: false, shells: [shell(1, commands[0]!, 9, true)] }).container
    expect(gone.querySelector(".chat-running")).toBeNull()
  })

  it("folds three shells into one line that opens and closes", async () => {
    const { container } = open({
      working: false,
      shells: commands.map((command, index) => shell(index, command, index + 1)),
    })
    expect(lines(container)).toHaveLength(1)
    expect(lines(container)[0]).toContain("3 shells")
    expect(lines(container)[0]).toContain("pnpm dev")
    expect(lines(container)[0]).toContain("tail -f")
    const toggle = container.querySelector<HTMLButtonElement>(".chat-shell-toggle")!
    expect(toggle.textContent).toBe("show")
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    await act(async () => void toggle.click())
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(toggle.textContent).toBe("hide")
    expect(container.querySelectorAll(".chat-shell .chat-fact")).toHaveLength(3)
    expect(lines(container)).toHaveLength(4)
    await act(async () => void toggle.click())
    expect(lines(container)).toHaveLength(1)
  })
})
