import {
  WordsLost,
  type ChatAnswer,
  type ChatDialog,
  type ChatRequest,
  type ChatSlice,
} from "@novadeck/core/conversation"
import { refusing } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { againMs, Requests } from "./Requests"
import { SliceKeys } from "./Slice"
import { describe, expect, it } from "./test"

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
  slice: ChatSlice | null = null,
) => {
  const element = (next: ChatDialog | null, flag = answered) =>
    createElement(Requests, {
      requests: [request(next, flag)],
      slice,
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

const terminalKey = (container: HTMLElement) =>
  container.querySelector('button[aria-label="Answer in terminal"]')

const click = (element: Element): void =>
  void act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })))

const settle = (): Promise<void> => act(async () => {})

describe("a request's card", () => {
  it("holds its rows and says so while an answer goes", async () => {
    const finishers: (() => void)[] = []
    const onAnswer = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(
      () => new Promise<void>((resolve) => finishers.push(resolve)),
    )
    const { container } = show(choices, onAnswer)
    click(button(container, "Yes"))
    expect(onAnswer).toHaveBeenCalledWith("r1", { type: "choice", dialog: "d1", option: "1" })
    expect(button(container, "Yes").disabled).toBe(true)
    expect(container.querySelector(".chat-sending")).not.toBeNull()
    expect(container.querySelector("article")?.getAttribute("aria-busy")).toBe("true")
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
    expect(terminalKey(container)).not.toBeNull()
  })

  it("shows each control that would reorder what it asks, as the terminal shows it in order", () => {
    // A right-to-left override hides `rm -rf ~` behind what reads as harmless.
    const hidden = "echo hi \u202E~ fr- mr\u202C; ls"
    const { container, rerender } = show(
      {
        ...choices,
        title: "Run \u2067this\u2069?",
        detail: hidden,
        options: [{ id: "1", label: "Yes, and allow \u202Eecho", text: null }],
      },
      async () => {},
    )
    expect(container.querySelector(".chat-option-words")?.textContent).toBe(
      "Yes, and allow ⟨U+202E⟩echo",
    )
    expect(container.querySelector(".chat-dialog-title")?.textContent).toBe(
      "Run ⟨U+2067⟩this⟨U+2069⟩?",
    )
    expect(container.querySelector("pre")?.textContent).toBe("echo hi ⟨U+202E⟩~ fr- mr⟨U+202C⟩; ls")
    rerender({ type: "raw", text: hidden, reason: "failed" })
    expect(container.querySelector("pre")?.textContent).toBe("echo hi ⟨U+202E⟩~ fr- mr⟨U+202C⟩; ls")
  })

  it("shows an answered request without its controls", () => {
    const { container } = show(choices, async () => {}, true)
    expect(container.querySelector(".chat-options")).toBeNull()
    expect(container.querySelector(".chat-request-answered")?.textContent).toContain("Claude")
    expect(terminalKey(container)).not.toBeNull()
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
    expect(terminalKey(container)).not.toBeNull()
  })

  it("keeps the words typed when the dialog is read again, and answers the new one", async () => {
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
    // The answer's promise settles the card once it's sent.
    await settle()
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
    const [hint] = container.querySelector("textarea")!.getAttribute("aria-describedby")!.split(" ")
    expect(container.querySelector(`[id="${hint}"]`)?.textContent).toContain("control characters")
  })
})

// Whether a key's default was prevented: a browser would have acted on it otherwise.
const keyDown = (element: Element, key: string, fields: KeyboardEventInit = {}): boolean => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...fields })
  act(() => void element.dispatchEvent(event))
  return event.defaultPrevented
}

const change = (input: HTMLInputElement, value: string): void =>
  void act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    set.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })

describe("a dialog's menu", () => {
  const rows = (container: HTMLElement) => [...container.querySelectorAll(".chat-option")]
  const on = (container: HTMLElement) =>
    rows(container).filter((row) => row.hasAttribute("data-on"))

  it("numbers its rows, out of their names, with the bar on the first", () => {
    const { container } = show(choices, async () => {})
    expect(
      rows(container).map((row) => row.querySelector(".chat-option-number")?.textContent),
    ).toEqual(["1", "2"])
    expect(
      rows(container)[0]?.querySelector(".chat-option-number")?.getAttribute("aria-hidden"),
    ).toBe("true")
    expect(on(container)).toEqual([rows(container)[0]])
  })

  it("moves the bar with the arrows, round and round, and focus with it", () => {
    const { container } = show(choices, async () => {})
    const [first, second] = rows(container) as HTMLElement[]
    first!.focus()
    keyDown(first!, "ArrowDown")
    expect(document.activeElement).toBe(second)
    expect(on(container)).toEqual([second])
    keyDown(second!, "ArrowDown")
    expect(document.activeElement).toBe(first)
    keyDown(first!, "ArrowUp")
    expect(document.activeElement).toBe(second)
  })

  it("keeps one row in the tab order", () => {
    const { container } = show(choices, async () => {})
    expect(rows(container).map((row) => row.getAttribute("tabindex"))).toEqual(["0", "-1"])
  })

  it("presses a row by its number", () => {
    const onAnswer = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(async () => {})
    const { container } = show(choices, onAnswer)
    keyDown(rows(container)[0]!, "1")
    expect(onAnswer).toHaveBeenCalledWith("r1", { type: "choice", dialog: "d1", option: "1" })
  })

  it("takes no focus as it appears: what the person is typing stays in their box", () => {
    const box = document.body.appendChild(document.createElement("textarea"))
    box.focus()
    show(choices, async () => {})
    expect(document.activeElement).toBe(box)
    box.remove()
  })

  it("offers the terminal only where the chat has no other way", () => {
    expect(terminalKey(show(choices, async () => {}).container)).toBeNull()
    expect(terminalKey(show(null, async () => {}).container)).not.toBeNull()
    expect(terminalKey(show(choices, async () => {}, true).container)).not.toBeNull()
    const raw = { type: "raw", text: "x", reason: "unrecognized" } as const
    expect(terminalKey(show(raw, async () => {}).container)).not.toBeNull()
  })

  it("has no need of the terminal with its live rows taking the keys", () => {
    const raw = { type: "raw", text: "x", reason: "unrecognized" } as const
    const slice: ChatSlice = {
      reason: "dialog",
      columns: 40,
      rows: [],
      cursor: null,
      secret: false,
    }
    const { container, unmount } = render(
      createElement(
        SliceKeys.Provider,
        { value: () => {} },
        createElement(Requests, {
          requests: [request(raw)],
          slice,
          agent: "Claude",
          onAnswer: async () => {},
          onAnswerInTerminal: () => {},
          onSettled,
          replying: null,
          replySending: false,
          onReply,
          refused: refusing(),
          onChatting,
        }),
      ),
    )
    unmounts.push(unmount)
    expect(terminalKey(container)).toBeNull()
    expect(container.querySelector(".chat-live-title")?.textContent).toContain(
      "Claude's own dialog",
    )
    expect(container.querySelector(".chat-raw-reason")?.className).toContain("sr-only")
  })

  it("says that an answer didn't take, over the live rows too", () => {
    const raw = { type: "raw", text: "x", reason: "failed" } as const
    const slice: ChatSlice = {
      reason: "dialog",
      columns: 40,
      rows: [],
      cursor: null,
      secret: false,
    }
    const { container } = show(raw, async () => {}, false, null, false, slice)
    expect(container.querySelector(".chat-raw-reason")?.className).not.toContain("sr-only")
  })

  it("says why it can't read a dialog it has no live rows of", () => {
    const raw = { type: "raw", text: "x", reason: "unrecognized" } as const
    const { container } = show(raw, async () => {})
    expect(container.querySelector(".chat-raw-reason")?.className).not.toContain("sr-only")
  })

  it("names the request's tool to a screen reader, not on its line", () => {
    const { container } = show(choices, async () => {})
    expect(container.querySelector("article")?.getAttribute("aria-label")).toBe(
      "Needs your permission: Bash",
    )
    expect(container.querySelector(".chat-request-head")?.textContent).toBe("Needs your permission")
  })

  it("says a subagent asks", () => {
    const { container } = render(
      createElement(Requests, {
        requests: [{ ...request(choices), subagent: true }],
        slice: null,
        agent: "Claude",
        onAnswer: async () => {},
        onAnswerInTerminal: () => {},
        onSettled,
        replying: null,
        replySending: false,
        onReply,
        refused: refusing(),
        onChatting,
      }),
    )
    expect(container.querySelector(".chat-request-head")?.textContent).toContain("subagent")
  })
})

describe("a dialog of questions", () => {
  const dialog: ChatDialog = {
    type: "questions",
    id: "q",
    chat: null,
    questions: [
      {
        id: "a",
        header: "Grace",
        question: "Keep the grace?",
        options: [
          { id: "keep", label: "Keep it", description: "As it is" },
          { id: "drop", label: "Drop it", description: null },
        ],
        multiSelect: false,
        text: true,
      },
      {
        id: "b",
        header: null,
        question: "Which tests?",
        options: [
          { id: "one", label: "Session", description: null },
          { id: "two", label: "Refresh", description: null },
        ],
        multiSelect: true,
        text: false,
      },
    ],
  }
  const tabs = (container: HTMLElement) => [...container.querySelectorAll('[role="tab"]')]
  const shownPage = (container: HTMLElement) => [
    ...container.querySelectorAll(".chat-page[data-shown]"),
  ]
  const input = (container: HTMLElement, name: string) =>
    [
      ...container.querySelectorAll<HTMLInputElement>("input[type=radio], input[type=checkbox]"),
    ].find((each) => each.closest("label")?.textContent?.includes(name))!
  const pick = (container: HTMLElement, name: string) => click(input(container, name))
  const answerAll = (container: HTMLElement) => {
    pick(container, "Keep it")
    pick(container, "Session")
  }

  it("has a tab for each, a name for one with no header, and one to send them", () => {
    const { container } = show(dialog, async () => {})
    expect(tabs(container).map((tab) => tab.textContent)).toEqual(["Grace", "Question 2", "Submit"])
    expect(tabs(container)[0]?.getAttribute("aria-selected")).toBe("true")
  })

  // Every harness's question request takes its first question as its subject.
  const asked = (answered: boolean) => {
    const { container, unmount } = render(
      createElement(Requests, {
        requests: [{ ...request(dialog, answered), kind: "question", subject: "Keep the grace?" }],
        slice: null,
        agent: "Claude",
        onAnswer: async () => {},
        onAnswerInTerminal: () => {},
        onSettled,
        replying: null,
        replySending: false,
        onReply,
        refused: refusing("/tmp is full", "x @a "),
        onChatting,
      }),
    )
    unmounts.push(unmount)
    return container
  }

  it("asks each question once, on its page, and not again as the request's subject", () => {
    const container = asked(false)
    expect(container.querySelector(".chat-request-subject")).toBeNull()
    expect(container.textContent?.split("Keep the grace?")).toHaveLength(2)
  })

  it("names what was asked once it's answered and the pages have gone", () => {
    const container = asked(true)
    expect(container.querySelector(".chat-request-subject")?.textContent).toBe("Keep the grace?")
  })

  it("keeps every page in its cell, one of them shown, so turning one moves nothing", () => {
    const { container } = show(dialog, async () => {})
    expect(container.querySelectorAll(".chat-pages > .chat-page")).toHaveLength(3)
    expect(shownPage(container)).toHaveLength(1)
    expect(shownPage(container)[0]?.textContent).toContain("Keep the grace?")
  })

  it("keeps real radios and checkboxes, named by their words alone", () => {
    const { container } = show(dialog, async () => {})
    expect(container.querySelector('[role="radiogroup"] input[type="radio"]')).not.toBeNull()
    expect(container.querySelector('[role="group"] input[type="checkbox"]')).not.toBeNull()
    const keep = input(container, "Keep it")
    const named = container.querySelector(`[id="${keep.getAttribute("aria-labelledby")}"]`)
    expect(named?.textContent).toBe("Keep it")
    const said = container.querySelector(`[id="${keep.getAttribute("aria-describedby")}"]`)
    expect(said?.textContent).toBe("As it is")
  })

  it("goes on to the next page once a single choice is picked, and marks the tab", () => {
    const { container } = show(dialog, async () => {})
    pick(container, "Keep it")
    expect(shownPage(container)[0]?.textContent).toContain("Which tests?")
    expect(tabs(container)[0]?.textContent).toBe("✓Grace")
  })

  it("stays on a page of several choices, marking each in a cell of its own", () => {
    const { container } = show(dialog, async () => {})
    click(tabs(container)[1]!)
    pick(container, "Session")
    expect(shownPage(container)[0]?.textContent).toContain("Which tests?")
    const marks = [...shownPage(container)[0]!.querySelectorAll(".chat-check")]
    expect(marks.map((mark) => mark.textContent)).toEqual(["[✓] ", "[] "])
  })

  it("moves the bar with the arrows without picking", () => {
    const { container } = show(dialog, async () => {})
    const keep = input(container, "Keep it")
    keep.focus()
    expect(keyDown(keep, "ArrowDown")).toBe(true)
    expect(document.activeElement).toBe(input(container, "Drop it"))
    expect(input(container, "Drop it").checked).toBe(false)
  })

  it("has no native group, which would pick as the arrows go and hide rows from Tab", () => {
    const { container } = show(dialog, async () => {})
    expect(input(container, "Keep it").name).toBe("")
  })

  it("turns the page with left and right, picking nothing, focus going along", async () => {
    const { container } = show(dialog, async () => {})
    const keep = input(container, "Keep it")
    keep.focus()
    expect(keyDown(keep, "ArrowRight")).toBe(true)
    await settle()
    expect(input(container, "Keep it").checked).toBe(false)
    expect(shownPage(container)[0]?.textContent).toContain("Which tests?")
    expect(document.activeElement).toBe(input(container, "Session"))
    keyDown(document.activeElement!, "ArrowLeft")
    await settle()
    expect(document.activeElement).toBe(input(container, "Keep it"))
  })

  it("picks the row the person is on with Enter, and goes on", async () => {
    const { container } = show(dialog, async () => {})
    const drop = input(container, "Drop it")
    drop.focus()
    expect(keyDown(drop, "Enter")).toBe(true)
    await settle()
    expect(input(container, "Drop it").checked).toBe(true)
    expect(shownPage(container)[0]?.textContent).toContain("Which tests?")
  })

  it("goes on with Enter from a page of several choices, marking nothing", async () => {
    const { container } = show(dialog, async () => {})
    click(tabs(container)[1]!)
    const session = input(container, "Session")
    session.focus()
    keyDown(session, "Enter")
    await settle()
    expect(session.checked).toBe(false)
    expect(shownPage(container)[0]?.textContent).toContain("Send these answers?")
  })

  it("doesn't run on with Enter held, which would answer the rest and send them", async () => {
    const { container } = show(dialog, async () => {})
    const drop = input(container, "Drop it")
    drop.focus()
    expect(keyDown(drop, "Enter", { repeat: true })).toBe(true)
    await settle()
    expect(drop.checked).toBe(false)
    expect(shownPage(container)[0]?.textContent).toContain("Keep the grace?")
  })

  it("leaves a key with a modifier to the app", () => {
    const { container } = show(dialog, async () => {})
    const keep = input(container, "Keep it")
    expect(keyDown(keep, "ArrowRight", { altKey: true })).toBe(false)
    expect(keyDown(keep, "Enter", { ctrlKey: true })).toBe(false)
    expect(keep.checked).toBe(false)
  })

  it("picks by a digit, and a held digit goes no further", async () => {
    const { container } = show(dialog, async () => {})
    const keep = input(container, "Keep it")
    keep.focus()
    keyDown(keep, "1")
    await settle()
    expect(input(container, "Keep it").checked).toBe(true)
    const session = input(container, "Session")
    keyDown(session, "1", { repeat: true })
    expect(session.checked).toBe(false)
  })

  it("goes on from an option picked already", () => {
    const { container } = show(dialog, async () => {})
    pick(container, "Keep it")
    click(tabs(container)[0]!)
    pick(container, "Keep it")
    expect(shownPage(container)[0]?.textContent).toContain("Which tests?")
  })

  it("leaves focus on a row that takes it, with an answer missing from the last page", async () => {
    const { container } = show(dialog, async () => {})
    const keep = input(container, "Keep it")
    keep.focus()
    keyDown(keep, "ArrowLeft")
    await settle()
    expect(document.activeElement).toBe(button(container, "Submit answers"))
  })

  it("holds everything while the answers go", async () => {
    const finishers: (() => void)[] = []
    const { container } = show(dialog, () => new Promise((resolve) => finishers.push(resolve)))
    answerAll(container)
    click(tabs(container)[2]!)
    await act(async () => void button(container, "Submit answers").click())
    expect(container.querySelector<HTMLFieldSetElement>("fieldset.chat-pages")?.disabled).toBe(true)
    expect(tabs(container).every((tab) => (tab as HTMLButtonElement).disabled)).toBe(true)
    finishers.forEach((finish) => finish())
    await settle()
    expect(tabs(container).every((tab) => !(tab as HTMLButtonElement).disabled)).toBe(true)
  })

  it("says on the page that sends why words with control characters can't go", () => {
    const { container } = show(dialog, async () => {})
    pick(container, "Session")
    change(container.querySelector<HTMLInputElement>('input[aria-label^="Other"]')!, "a\u001bb")
    click(tabs(container)[2]!)
    expect(shownPage(container)[0]?.querySelector(".chat-review-hint")?.textContent).toContain(
      "control characters",
    )
    const submit = button(container, "Submit answers")
    expect(submit.getAttribute("aria-disabled")).toBe("true")
    const why = container.querySelector(`[id="${submit.getAttribute("aria-describedby")}"]`)
    expect(why?.textContent).toContain("control characters")
  })

  it("takes the person's own words on a row of its own, and Enter goes on", () => {
    const { container } = show(dialog, async () => {})
    const own = container.querySelector<HTMLInputElement>('input[aria-label^="Other"]')!
    change(own, "Ask support")
    expect(tabs(container)[0]?.textContent).toBe("✓Grace")
    keyDown(own, "Enter")
    expect(shownPage(container)[0]?.textContent).toContain("Which tests?")
  })

  it("holds digits typed in the person's own words as words", () => {
    const { container } = show(dialog, async () => {})
    const own = container.querySelector<HTMLInputElement>('input[aria-label^="Other"]')!
    keyDown(own, "1")
    expect(input(container, "Keep it").checked).toBe(false)
  })

  it("can't send until each has an answer, and says which hasn't", () => {
    const { container } = show(dialog, async () => {})
    click(tabs(container)[2]!)
    const page = shownPage(container)[0]!
    expect(page.textContent).toContain("not answered")
    expect(button(container, "Submit answers").getAttribute("aria-disabled")).toBe("true")
  })

  it("sends the answers, listing them first", async () => {
    const onAnswer = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(async () => {})
    const { container } = show(dialog, onAnswer)
    answerAll(container)
    click(tabs(container)[2]!)
    expect(shownPage(container)[0]?.querySelector("dl")?.textContent).toContain("Keep it")
    await act(async () => void button(container, "Submit answers").click())
    expect(onAnswer).toHaveBeenCalledWith("r1", {
      type: "questions",
      dialog: "q",
      answers: [
        { question: "a", options: ["keep"] },
        { question: "b", options: ["one"] },
      ],
    })
  })

  it("starts over from the first page, with nothing picked", () => {
    const { container } = show(dialog, async () => {})
    answerAll(container)
    click(tabs(container)[2]!)
    click(button(container, "Start over"))
    expect(shownPage(container)[0]?.textContent).toContain("Keep the grace?")
    expect(input(container, "Keep it").checked).toBe(false)
  })

  it("counts the answers for a screen reader", () => {
    const { container } = show(dialog, async () => {})
    expect(container.querySelector('[role="status"].sr-only')?.textContent).toBe("0 of 2 answered")
  })
})

describe("a form", () => {
  const dialog: ChatDialog = {
    type: "form",
    id: "f",
    message: "Set the deploy up",
    fields: [
      {
        id: "name",
        label: "Name",
        description: "What to call it",
        kind: "text",
        choices: [],
        required: true,
      },
      {
        id: "env",
        label: "Where",
        description: null,
        kind: "choice",
        choices: ["a", "b"],
        required: false,
      },
      {
        id: "dry",
        label: "Dry run",
        description: null,
        kind: "boolean",
        choices: [],
        required: false,
      },
      { id: "n", label: "Count", description: null, kind: "number", choices: [], required: false },
    ],
  }
  const field = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll(".chat-form-field")].find((each) =>
      each.textContent?.includes(label),
    )!
  const radio = (container: HTMLElement, label: string, name: string) =>
    [...field(container, label).querySelectorAll<HTMLInputElement>("input[type=radio]")].find(
      (each) => each.closest("label")?.textContent === name,
    )!

  it("draws a line per field, saying which are required", () => {
    const { container } = show(dialog, async () => {})
    expect(container.querySelectorAll(".chat-form-field")).toHaveLength(4)
    expect(field(container, "Name").querySelector("input")?.placeholder).toBe("required")
    expect(field(container, "Count").querySelector("input")?.placeholder).toBe("optional")
    expect(field(container, "Name").textContent).toContain("What to call it")
  })

  it("picks one of a set among its words, in a radio group named by the field", () => {
    const { container } = show(dialog, async () => {})
    const group = field(container, "Where").querySelector('[role="radiogroup"]')!
    expect(
      container.querySelector(`[id="${group.getAttribute("aria-labelledby")}"]`)?.textContent,
    ).toBe("Where")
    click(radio(container, "Where", "b"))
    expect(radio(container, "Where", "b").checked).toBe(true)
    expect(radio(container, "Where", "b").closest("label")?.hasAttribute("data-on")).toBe(true)
  })

  it("tells yes, no and unset apart, and takes a pick back", async () => {
    const onAnswer = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(async () => {})
    const { container } = show(dialog, onAnswer)
    change(field(container, "Name").querySelector("input")!, "api")
    click(radio(container, "Dry run", "No"))
    expect(radio(container, "Dry run", "No").checked).toBe(true)
    click(radio(container, "Dry run", "No"))
    expect(radio(container, "Dry run", "No").checked).toBe(false)
    await act(async () => void button(container, "Submit").click())
    expect(onAnswer).toHaveBeenCalledWith("r1", {
      type: "form",
      dialog: "f",
      action: "accept",
      values: { name: "api" },
    })
  })

  it("says what is missing once the person tries to submit, sending nothing", () => {
    const onAnswer = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(async () => {})
    const { container } = show(dialog, onAnswer)
    expect(field(container, "Name").hasAttribute("data-missing")).toBe(false)
    expect(button(container, "Submit").getAttribute("aria-disabled")).toBe("true")
    click(button(container, "Submit"))
    expect(onAnswer).not.toHaveBeenCalled()
    expect(field(container, "Name").hasAttribute("data-missing")).toBe(true)
  })

  it("takes a pick back with Space, for the keyboard", () => {
    const { container } = show(dialog, async () => {})
    click(radio(container, "Dry run", "Yes"))
    expect(keyDown(radio(container, "Dry run", "Yes"), " ")).toBe(true)
    expect(radio(container, "Dry run", "Yes").checked).toBe(false)
  })

  it("marks what is required, a picked set's label naming it to a screen reader", () => {
    const { container } = show(dialog, async () => {})
    expect(field(container, "Name").querySelector(".chat-required")?.textContent).toBe(" *")
    expect(field(container, "Where").querySelector("label.chat-form-label")).toBeNull()
  })

  it("marks a number that isn't one as it is typed", () => {
    const { container } = show(dialog, async () => {})
    const count = field(container, "Count").querySelector("input")!
    count.type = "text"
    change(count, "x")
    expect(field(container, "Count").hasAttribute("data-missing")).toBe(true)
  })

  it("declines with nothing filled in", async () => {
    const onAnswer = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(async () => {})
    const { container } = show(dialog, onAnswer)
    await act(async () => void button(container, "Decline").click())
    expect(onAnswer).toHaveBeenCalledWith("r1", {
      type: "form",
      dialog: "f",
      action: "decline",
      values: {},
    })
  })
})
