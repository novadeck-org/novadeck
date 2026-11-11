import { noConversation, type ChatItem, type Conversation } from "@novadeck/core/conversation"
import { createStore } from "@novadeck/core/store"
import { refusing } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { ChatView } from "./ChatView"
import type { WindowPhase } from "./mark-phase"
import { describe, expect, it } from "./test"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const item = (id: string, over: Partial<ChatItem>): ChatItem => ({
  id,
  at: Date.UTC(2026, 10, 11, 12, 0, 0) + Number(id) * 60_000,
  role: "user",
  kind: "text",
  text: "",
  truncated: false,
  tool: null,
  call: null,
  author: null,
  run: null,
  outcome: null,
  scripted: false,
  interrupted: false,
  ring: null,
  ...over,
})
const said = (id: string, text: string) => item(id, { text })
const answer = (id: string) => item(id, { role: "assistant", text: `Reply ${id}` })
const ringed = (id: string) =>
  item(id, { text: "[Novadeck: automatic notice]", ring: { nonce: "n", replies: false } })

// Layout jsdom doesn't have: each turn's row (by its block's id) at a top and 20 high, in a log
// scrolled to `scrolled`, which the chat reads as it would from the page.
const scenario = (tops: Readonly<Record<string, number>>, extent = 1000) => {
  const state = { scrolled: 0, set: [] as number[] }
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const top = this.classList.contains("chat-scroll")
      ? 0
      : (tops[(this as HTMLElement).dataset.turn ?? ""] ?? 0) - state.scrolled
    const own = (this as HTMLElement).dataset?.turn !== undefined
    return {
      top,
      bottom: top + (own ? 20 : 500),
      left: 0,
      right: 0,
      width: 0,
      height: 0,
    } as DOMRect
  })
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(() => state.scrolled)
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation((value: number) => {
    state.set.push(value)
  })
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(() => extent)
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(() => 500)
  return state
}

const open = (
  items: readonly ChatItem[],
  {
    working = false,
    windowPhase,
    interrupt = vi.fn<() => Promise<void>>(async () => {}),
  }: {
    working?: boolean
    windowPhase?: WindowPhase
    interrupt?: () => Promise<void>
  } = {},
) => {
  const conversation = createStore<Conversation>({
    ...noConversation,
    agent: "claude",
    session: "s",
    loaded: true,
    items,
  })
  const { container, unmount } = render(
    createElement(ChatView, {
      conversation,
      terminalName: "T",
      program: "claude",
      agent: working ? { working: true } : { working: false },
      compact: false,
      windowPhase,
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

// Scrolls the log, as a person does.
const scrollTo = (container: HTMLElement, state: { scrolled: number }, to: number): void => {
  state.scrolled = to
  act(() => void container.querySelector(".chat-scroll")!.dispatchEvent(new Event("scroll")))
}

const hold = (container: HTMLElement) => container.querySelector<HTMLElement>(".chat-hold")
const words = (container: HTMLElement) => hold(container)?.querySelector(".chat-hold-words")
const press = (element: Element): void =>
  act(() => void element.dispatchEvent(new MouseEvent("click", { bubbles: true })))
const esc = (target: Element): void =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    )
  })

// Two turns of the person's, 200 apart.
const twoTurns = [
  said("1", "Why does the cart\nround down?\n\n[Image #1] has the numbers."),
  answer("2"),
  said("3", "Fix it."),
  answer("4"),
]
const tops = { "1": 0, "3": 200 }

describe("the prompt that holds the top of the log", () => {
  it("shows once the turn's prompt is wholly above the log's top, as one line", () => {
    const layout = scenario(tops)
    const { container } = open(twoTurns)
    expect(hold(container)).toBeNull()
    scrollTo(container, layout, 10)
    expect(hold(container)).toBeNull()
    scrollTo(container, layout, 60)
    expect(words(container)?.textContent).toBe(
      "Why does the cart round down? [Image #1] has the numbers.",
    )
    expect(hold(container)?.querySelector(".chat-mark")).not.toBeNull()
  })

  it("is the turn at the top: an earlier prompt where the person scrolled back into it", () => {
    const layout = scenario(tops)
    const { container } = open(twoTurns)
    scrollTo(container, layout, 400)
    expect(words(container)?.textContent).toBe("Fix it.")
    scrollTo(container, layout, 100)
    expect(words(container)?.textContent).toContain("Why does the cart")
  })

  it("is pushed up and out by the next turn's start, which then takes over", () => {
    const layout = scenario(tops)
    const { container } = open(twoTurns)
    scrollTo(container, layout, 180)
    expect(hold(container)?.style.transform).toBe("translateY(-17px)")
    scrollTo(container, layout, 200)
    expect(hold(container)).toBeNull()
    scrollTo(container, layout, 230)
    expect(words(container)?.textContent).toBe("Fix it.")
    expect(hold(container)?.style.transform).toBe("")
  })

  it("holds nothing for a turn a ring started, but the ring ends the line before it", () => {
    const layout = scenario({ "1": 0, "3": 200 })
    const { container } = open([said("1", "Review it."), answer("2"), ringed("3"), answer("4")])
    scrollTo(container, layout, 180)
    expect(hold(container)?.style.transform).toBe("translateY(-17px)")
    scrollTo(container, layout, 300)
    expect(hold(container)).toBeNull()
  })

  it("starts no turn at a prompt the record doesn't hold yet", () => {
    scenario(tops)
    const { container } = open(twoTurns.slice(0, 2))
    expect(container.querySelectorAll("[data-turn]")).toHaveLength(1)
  })

  it("is over the log, not among its rows, which never move for it", () => {
    const layout = scenario(tops)
    const { container } = open(twoTurns)
    const before = container.querySelector(".chat-thread")!.children.length
    scrollTo(container, layout, 60)
    expect(container.querySelector(".chat-thread")!.children).toHaveLength(before)
    expect(hold(container)?.parentElement?.classList.contains("chat-main")).toBe(true)
  })
})

describe("the prompt's time and steps", () => {
  it("show its time, and steps that stop at the first and the latest prompt", () => {
    const layout = scenario(tops)
    const { container } = open(twoTurns)
    scrollTo(container, layout, 400)
    expect(container.querySelector(".chat-hold-time")?.textContent).toMatch(/\d/)
    const before = container.querySelector<HTMLButtonElement>('[aria-label="Previous prompt"]')!
    const after = container.querySelector<HTMLButtonElement>('[aria-label="Next prompt"]')!
    expect(before.disabled).toBe(false)
    expect(after.disabled).toBe(true)
    scrollTo(container, layout, 100)
    expect(before.disabled).toBe(true)
    expect(after.disabled).toBe(false)
  })

  it("scroll to the prompt before or after, so that it holds the top", () => {
    const layout = scenario(tops)
    const { container } = open(twoTurns)
    scrollTo(container, layout, 400)
    layout.set.length = 0
    press(container.querySelector('[aria-label="Previous prompt"]')!)
    expect(layout.set.at(-1)).toBe(20)
    scrollTo(container, layout, 100)
    press(container.querySelector('[aria-label="Next prompt"]')!)
    expect(layout.set.at(-1)).toBe(220)
  })
})

describe("the peek", () => {
  const peeking = () => {
    const layout = scenario(tops)
    const interrupt = vi.fn<() => Promise<void>>(async () => {})
    const view = open(twoTurns, { working: true, interrupt })
    scrollTo(view.container, layout, 60)
    press(view.container.querySelector(".chat-hold-line")!)
    return { ...view, layout }
  }

  it("unfolds the line into the whole prompt, with its footer", () => {
    const { container } = peeking()
    expect(hold(container)?.hasAttribute("data-open")).toBe(true)
    expect(words(container)?.textContent).toBe(
      "Why does the cart\nround down?\n\n[Image #1] has the numbers.",
    )
    expect(words(container)?.getAttribute("aria-label")).toBe("Your prompt, whole")
    const foot = hold(container)?.querySelector(".chat-hold-foot")
    expect(foot?.textContent).toContain("go to it ↑")
    expect(foot?.querySelector("kbd")?.textContent).toBe("esc")
    // The log doesn't move for it.
    expect(container.querySelectorAll("[data-turn]")).toHaveLength(2)
  })

  it("closes at Esc before Esc stops the agent, which the next Esc does", async () => {
    const { container, interrupt } = peeking()
    esc(container.querySelector(".chat-input")!)
    expect(hold(container)?.hasAttribute("data-open")).toBe(false)
    expect(interrupt).not.toHaveBeenCalled()
    await act(async () => esc(container.querySelector(".chat-input")!))
    expect(interrupt).toHaveBeenCalledOnce()
  })

  it("closes at a press outside it, and not at one inside", () => {
    const { container } = peeking()
    act(() => void words(container)!.dispatchEvent(new Event("pointerdown", { bubbles: true })))
    expect(hold(container)?.hasAttribute("data-open")).toBe(true)
    act(() => void document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })))
    expect(hold(container)?.hasAttribute("data-open")).toBe(false)
  })

  it("goes to the prompt and closes", () => {
    const { container, layout } = peeking()
    const go = [...container.querySelectorAll<HTMLButtonElement>(".chat-hold-foot button")].find(
      (each) => each.textContent?.includes("go to it"),
    )!
    layout.set.length = 0
    press(go)
    expect(layout.set.at(-1)).toBe(0)
    expect(hold(container)?.hasAttribute("data-open")).toBe(false)
  })

  it("closes with its line, as the prompt stops holding the top", () => {
    const { container, layout } = peeking()
    scrollTo(container, layout, 0)
    expect(hold(container)).toBeNull()
    scrollTo(container, layout, 60)
    expect(hold(container)?.hasAttribute("data-open")).toBe(false)
  })

  it("is reached by keys: the line is a button that says it is shut", () => {
    const layout = scenario(tops)
    const { container } = open(twoTurns)
    scrollTo(container, layout, 60)
    const line = container.querySelector<HTMLButtonElement>(".chat-hold-line")!
    expect(line.tagName).toBe("BUTTON")
    expect(line.getAttribute("aria-expanded")).toBe("false")
    expect(line.getAttribute("aria-label")).toContain("Show it whole")
  })
})

describe("the current turn's mark", () => {
  const marks = (container: HTMLElement) =>
    [...container.querySelectorAll('.chat-thread > [data-role="user"] > .chat-mark')].map((mark) =>
      mark.getAttribute("data-phase"),
    )

  it("takes the window's phase on the latest prompt only, in the log and on the held line", () => {
    const layout = scenario(tops)
    const { container } = open(twoTurns, {
      working: true,
      windowPhase: { phase: "running", need: false, failed: false },
    })
    expect(marks(container)).toEqual([null, "running"])
    scrollTo(container, layout, 400)
    expect(hold(container)?.querySelector(".chat-mark")?.getAttribute("data-phase")).toBe("running")
    // Scrolled back into the earlier turn, whose prompt keeps the still accent.
    scrollTo(container, layout, 100)
    expect(hold(container)?.querySelector(".chat-mark")?.hasAttribute("data-phase")).toBe(false)
  })

  it("resolves a need over a stopped agent, and leaves an idle one's still", () => {
    scenario(tops)
    const needs = open(twoTurns, { windowPhase: { phase: "idle", need: true, failed: false } })
    expect(marks(needs.container)).toEqual([null, "need"])
    const idle = open(twoTurns, { windowPhase: { phase: "idle", need: false, failed: false } })
    expect(marks(idle.container)).toEqual([null, null])
  })

  it("is the still accent everywhere without a window phase, and for a ring's turn", () => {
    scenario(tops)
    expect(marks(open(twoTurns).container)).toEqual([null, null])
    const rung = open([said("1", "Review it."), answer("2"), ringed("3"), answer("4")], {
      windowPhase: { phase: "running", need: false, failed: false },
    })
    expect(marks(rung.container)).toEqual([null])
  })
})

describe("the jump to the latest", () => {
  it("floats at the bottom right while the log isn't at its end, clear of any pinned line", () => {
    const layout = scenario(tops, 3000)
    const { container } = open(twoTurns, { working: true })
    expect(container.querySelector(".chat-jump")).toBeNull()
    scrollTo(container, layout, 400)
    const jump = container.querySelector<HTMLElement>(".chat-jump")!
    expect(jump.textContent).toBe("latest ↓")
    expect(jump.hasAttribute("data-pinned")).toBe(false)
    expect(jump.getAttribute("style")).toBeNull()
  })
})
