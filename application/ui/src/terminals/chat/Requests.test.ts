import { act, createElement } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import {
  WordsLost,
  type ChatAnswer,
  type ChatDialog,
  type ChatRequest,
} from "../../model/conversation"
import { describe, expect, it } from "../../test"
import { refusing } from "../../test/fixtures"
import { render } from "../../test/render"
import { againMs, Requests } from "./Requests"

const unmounts: (() => void)[] = []
afterEach(() => {
  unmounts.splice(0).forEach((unmount) => unmount())
  onSettled.mockClear()
  onReply.mockClear()
  onChatting.mockClear()
})

const fieldChoices: ChatDialog = {
  type: "choices",
  id: "d1",
  title: null,
  detail: null,
  options: [{ id: "2", label: "No, and tell it", text: "field" }],
}

const type = (field: HTMLTextAreaElement, value: string): void =>
  void act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    set.call(field, value)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })

const choices: ChatDialog = {
  type: "choices",
  id: "d1",
  title: null,
  detail: null,
  options: [
    { id: "1", label: "Yes", text: null },
    { id: "2", label: "No, and tell it what to do", text: "prompt" },
  ],
}

const request = (dialog: ChatDialog | null, answered = false): ChatRequest => ({
  id: "r1",
  kind: "permission",
  tool: "Bash",
  subject: "ls",
  choices: [],
  subagent: false,
  dialog,
  answered,
})

const questions = (chat: "field" | "prompt"): ChatDialog => ({
  type: "questions",
  id: "q1",
  chat,
  questions: [
    {
      id: "a",
      header: null,
      question: "Which?",
      options: [{ id: "x", label: "X", description: null }],
      multiSelect: false,
      text: false,
    },
  ],
})

const onSettled = vi.fn<() => void>()
const onReply = vi.fn<(request: string, dialog: string | null) => void>()
const onChatting = vi.fn<() => void>()

const show = (
  dialog: ChatDialog | null,
  onAnswer: (request: string, answer: ChatAnswer) => Promise<void>,
  answered = false,
  replying: string | null = null,
  replySending = false,
) => {
  const element = (next: ChatDialog | null, flag = answered) =>
    createElement(Requests, {
      requests: [request(next, flag)],
      agent: "Claude",
      onAnswer,
      onAnswerInTerminal: () => {},
      onSettled,
      replying,
      replySending,
      onReply,
      refused: refusing("/tmp is full", "x @a "),
      onChatting,
    })
  const { container, rerender, unmount } = render(element(dialog, answered))
  unmounts.push(unmount)
  return {
    container,
    unmount,
    rerender: (next: ChatDialog | null, flag = answered) => rerender(element(next, flag)),
  }
}

const button = (container: HTMLElement, name: string): HTMLButtonElement =>
  [...container.querySelectorAll("button")].find((each) => each.textContent?.includes(name))!

const click = (element: Element): void =>
  void act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })))

const settle = (): Promise<void> => act(async () => {})

describe("a request's card", () => {
  it("holds its buttons and shows a spinner while an answer goes", async () => {
    const finishers: (() => void)[] = []
    const onAnswer = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(
      () => new Promise<void>((resolve) => finishers.push(resolve)),
    )
    const { container } = show(choices, onAnswer)
    click(button(container, "Yes"))
    expect(onAnswer).toHaveBeenCalledWith("r1", { type: "choice", dialog: "d1", option: "1" })
    expect(button(container, "Yes").disabled).toBe(true)
    expect(container.querySelector(".chat-spinner")).not.toBeNull()
    finishers.forEach((finish) => finish())
    await settle()
    expect(button(container, "Yes").disabled).toBe(false)
  })

  it("says why an answer didn't go, and clears it once the person changes something", async () => {
    const onAnswer = vi.fn<() => Promise<void>>(async () => {
      throw new Error("That answer didn't take. Answer it in the terminal.")
    })
    const { container } = show(choices, onAnswer)
    click(button(container, "Yes"))
    await settle()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "That answer didn't take. Answer it in the terminal.",
    )
    click(button(container, "No, and tell"))
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it("asks for words before an option that takes them is sent", () => {
    const onAnswer = vi.fn<() => Promise<void>>(async () => {})
    const { container } = show(choices, onAnswer)
    click(button(container, "No, and tell"))
    expect(onAnswer).not.toHaveBeenCalled()
    expect(container.querySelector("textarea")?.getAttribute("aria-label")).toBe(
      "No, and tell it what to do",
    )
    expect(button(container, "Send answer").disabled).toBe(true)
  })

  it("swaps its controls for the dialog's text when the dialog turns raw", () => {
    const { container, rerender } = show(choices, async () => {})
    rerender({ type: "raw", text: "Allow this?\n1. Yes", reason: "failed" })
    expect(container.querySelector(".chat-options")).toBeNull()
    expect(container.querySelector("pre")?.textContent).toBe("Allow this?\n1. Yes")
    expect(container.textContent).toContain("That answer didn't take.")
    expect(button(container, "Answer in terminal")).toBeDefined()
  })

  it("shows an answered request without its controls", () => {
    const { container } = show(choices, async () => {}, true)
    expect(container.querySelector(".chat-options")).toBeNull()
    expect(container.querySelector(".chat-request-answered")?.textContent).toContain("Claude")
    expect(button(container, "Answer in terminal")).toBeDefined()
  })

  it("sets the questions aside at once where the words go on as a prompt", async () => {
    const onAnswer = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(async () => {})
    const { container } = show(questions("prompt"), onAnswer)
    click(button(container, "Chat about this"))
    expect(onAnswer).toHaveBeenCalledWith("r1", { type: "chat", dialog: "q1" })
    expect(container.querySelector("textarea")).toBeNull()
    await settle()
    expect(onChatting).toHaveBeenCalledOnce()
    expect(onReply).not.toHaveBeenCalled()
  })

  it("hands the words to the chat's box where the agent's own field takes them", () => {
    const onAnswer = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(async () => {})
    const asked = show(questions("field"), onAnswer)
    click(button(asked.container, "Chat about this"))
    expect(onReply).toHaveBeenCalledWith("r1", "q1")
    expect(onAnswer).not.toHaveBeenCalled()
    asked.unmount()
    const { container } = show(questions("field"), onAnswer, false, "r1")
    expect(container.querySelector('input[type="radio"]')).toBeNull()
    expect(container.textContent).toContain("Your reply in the box below")
    expect(button(container, "Submit")).toBeUndefined()
    click(button(container, "Back to the questions"))
    expect(onReply).toHaveBeenLastCalledWith("r1", null)
  })

  it("holds its controls while the box's answer to it goes", () => {
    const { container } = show(questions("field"), async () => {}, false, "r1", true)
    expect(button(container, "Back to the questions").disabled).toBe(true)
  })

  it("leaves focus where the person moved it once the questions went aside", async () => {
    const finishers: (() => void)[] = []
    const onAnswer = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(
      () => new Promise<void>((resolve) => finishers.push(resolve)),
    )
    const elsewhere = document.createElement("input")
    document.body.append(elsewhere)
    try {
      const { container } = show(questions("prompt"), onAnswer)
      click(button(container, "Chat about this"))
      elsewhere.focus()
      await act(async () => finishers[0]!())
      expect(onChatting).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(elsewhere)
    } finally {
      elsewhere.remove()
    }
  })

  it("waits for a dialog it hasn't read yet, with the options it knows", () => {
    const { container } = show(null, async () => {})
    expect(container.textContent).toContain("Waiting for the dialog…")
    expect(button(container, "Answer in terminal")).toBeDefined()
  })

  it("keeps the words typed when the dialog is read again, and answers the new one", () => {
    const onAnswer = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(async () => {})
    const { container, rerender } = show(choices, onAnswer)
    click(button(container, "No, and tell"))
    const field = container.querySelector("textarea")!
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
      set.call(field, "use pnpm")
      field.dispatchEvent(new Event("input", { bubbles: true }))
    })
    rerender({ ...choices, id: "d2", detail: "ls -la" } as ChatDialog)
    expect(container.querySelector("textarea")?.value).toBe("use pnpm")
    expect(container.querySelector("pre")?.textContent).toBe("ls -la")
    click(button(container, "Send answer"))
    expect(onAnswer).toHaveBeenCalledWith("r1", {
      type: "choice",
      dialog: "d2",
      option: "2",
      text: "use pnpm",
    })
  })

  it("closes the words field when a re-read dialog's option no longer means the same", () => {
    const { container, rerender } = show(choices, async () => {})
    click(button(container, "No, and tell"))
    expect(container.querySelector("textarea")).not.toBeNull()
    rerender({
      type: "choices",
      id: "d2",
      title: null,
      detail: null,
      options: [
        { id: "1", label: "Yes", text: null },
        { id: "2", label: "No, cancel everything", text: "prompt" },
      ],
    })
    expect(container.querySelector("textarea")).toBeNull()
  })

  describe("after an answer took", () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it("says so when the same dialog is still there", async () => {
      const { container } = show(choices, async () => {})
      click(button(container, "Yes"))
      await settle()
      expect(container.querySelector(".chat-request-again")).toBeNull()
      await act(async () => void vi.advanceTimersByTime(againMs))
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        "Another identical request",
      )
    })

    it("stays quiet when the runner marked the request answered", async () => {
      const { container, rerender } = show(choices, async () => {})
      click(button(container, "Yes"))
      await settle()
      rerender(choices, true)
      await act(async () => void vi.advanceTimersByTime(againMs))
      expect(container.querySelector(".chat-request-again")).toBeNull()
      expect(container.querySelector(".chat-request-answered")?.textContent).toBe(
        "Answered. Waiting for Claude…",
      )
    })

    it("drops a pending notice when the next answer starts", async () => {
      const calls: (() => void)[] = []
      const onAnswer = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(() =>
        calls.length === 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => calls.push(resolve)),
      )
      const { container } = show(choices, onAnswer)
      click(button(container, "Yes"))
      await settle()
      calls.push(() => {})
      click(button(container, "Yes"))
      await act(async () => void vi.advanceTimersByTime(againMs))
      expect(container.querySelector(".chat-request-again")).toBeNull()
    })

    it("shows the notice only while the dialog is the one it is about", async () => {
      const { container, rerender } = show(choices, async () => {})
      click(button(container, "Yes"))
      await settle()
      await act(async () => void vi.advanceTimersByTime(againMs))
      expect(container.querySelector(".chat-request-again")).not.toBeNull()
      rerender({ ...choices, id: "d2" } as ChatDialog)
      expect(container.querySelector(".chat-request-again")).toBeNull()
      rerender(choices)
      expect(container.querySelector(".chat-request-again")).not.toBeNull()
    })

    it("stays quiet when the dialog went or changed", async () => {
      const { container, rerender } = show(choices, async () => {})
      click(button(container, "Yes"))
      await settle()
      rerender({ ...choices, id: "d2" } as ChatDialog)
      await act(async () => void vi.advanceTimersByTime(againMs))
      expect(container.querySelector(".chat-request-again")).toBeNull()
    })
  })

  it("keeps words for the agent's own field to one line, with a hint", () => {
    const { container } = show(fieldChoices, async () => {})
    click(button(container, "No, and tell"))
    const field = container.querySelector("textarea")!
    type(field, "use pnpm\ninstead\tplease")
    expect(field.value).toBe("use pnpm instead please")
    expect(container.textContent).toContain("takes one line")
    const key = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => void field.dispatchEvent(key))
    expect(key.defaultPrevented).toBe(true)
  })

  it("lets words that become a prompt run to several lines", () => {
    const { container } = show(choices, async () => {})
    click(button(container, "No, and tell"))
    const field = container.querySelector("textarea")!
    type(field, "a\nb")
    expect(field.value).toBe("a\nb")
    expect(container.textContent).not.toContain("takes one line")
  })

  it("says the answer took but the words didn't", async () => {
    const onAnswer = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(async () => {
      throw new WordsLost()
    })
    const { container } = show(choices, onAnswer)
    click(button(container, "No, and tell"))
    type(container.querySelector("textarea")!, "use pnpm")
    click(button(container, "Send answer"))
    await settle()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Answered, but your words didn't reach the agent.",
    )
    // They are in the box now: the card's field no longer holds them.
    expect(container.querySelector("textarea")).toBeNull()
  })

  it("moves focus to the box once an answered card has gone", async () => {
    const { container, unmount } = show(choices, async () => {})
    click(button(container, "Yes"))
    await settle()
    expect(onSettled).not.toHaveBeenCalled()
    unmount()
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it("warns of words the agent would read as a command, and holds them back", () => {
    const { container } = show(choices, async () => {})
    click(button(container, "No, and tell"))
    type(container.querySelector("textarea")!, "/tmp is full")
    expect(container.textContent).toContain("Can't start with / or !")
    expect(button(container, "Send answer").disabled).toBe(true)
    type(container.querySelector("textarea")!, "the /tmp is full")
    expect(container.textContent).not.toContain("Can't start with / or !")
    expect(button(container, "Send answer").disabled).toBe(false)
  })

  it("holds back the words the backend refuses, and not those typed into the agent's field", () => {
    const { container } = show(choices, async () => {})
    click(button(container, "No, and tell"))
    type(container.querySelector("textarea")!, "x @a ")
    expect(button(container, "Send answer").disabled).toBe(true)
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Can't start")
    const field = show(fieldChoices, async () => {}).container
    click(button(field, "No, and tell"))
    type(field.querySelector("textarea")!, "/tmp is full")
    expect(button(field, "Send answer").disabled).toBe(false)
  })

  it("holds back words with control characters for the agent's own field, saying why", () => {
    const { container } = show(fieldChoices, async () => {})
    click(button(container, "No, and tell"))
    type(container.querySelector("textarea")!, "log \u001b[31mred")
    expect(button(container, "Send answer").disabled).toBe(true)
    const hint = container.querySelector("textarea")!.getAttribute("aria-describedby")!
    expect(container.querySelector(`[id="${hint}"]`)?.textContent).toContain("control characters")
  })
})
