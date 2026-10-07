import { act, createElement, useState } from "react"
import { afterEach, vi } from "vitest"

import {
  WordsLost,
  noConversation,
  type ChatAnswer,
  type Conversation,
} from "../../model/conversation"
import { createStore } from "../../model/store"
import { describe, expect, it } from "../../test"
import { render } from "../../test/render"
import { ChatView } from "./ChatView"
import type { ChatReplyTo } from "./mode-state"

// The chat as its owner holds it: the question its draft replies to kept outside it, as the
// app keeps it beside the draft, so it outlives the chat leaving the screen (`mounted`).
const Hosted = ({
  mounted = true,
  ...props
}: Omit<Parameters<typeof ChatView>[0], "replyTo" | "onReplyTo"> & {
  readonly mounted?: boolean
}): React.JSX.Element | null => {
  const [replyTo, setReplyTo] = useState<ChatReplyTo | null>(null)
  return mounted ? createElement(ChatView, { ...props, replyTo, onReplyTo: setReplyTo }) : null
}

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const asking: Conversation = {
  ...noConversation,
  agent: "claude",
  session: "s",
  loaded: true,
  requests: [
    {
      id: "r1",
      kind: "permission",
      tool: "Bash",
      subject: null,
      choices: [],
      subagent: false,
      answered: false,
      dialog: {
        type: "choices",
        id: "d1",
        title: null,
        detail: null,
        options: [{ id: "2", label: "No, and tell Claude", text: "prompt" }],
      },
    },
  ],
}

const set = (field: HTMLTextAreaElement, value: string): void =>
  void act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    setter.call(field, value)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })

describe("a chat whose answer's words didn't reach the agent", () => {
  it("hands the words back and says so, though the card went before the failure came", async () => {
    const store = createStore<Conversation>(asking)
    const failures: ((failure: unknown) => void)[] = []
    const onAnswer = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(
      () => new Promise<void>((_resolve, reject) => failures.push(reject)),
    )
    const onWordsLost = vi.fn<(words: string) => void>()
    const props = {
      conversation: store,
      terminalName: "T",
      program: "claude",
      agent: undefined,
      compact: false,
      draft: "",
      onDraft: () => {},
      onDraftSent: () => {},
      onSend: async () => {},
      onInterrupt: async () => {},
      onAnswer,
      onWordsLost,
      onAnswerInTerminal: () => {},
      focusInput: false,
      onInputFocused: () => {},
    }
    const { container, unmount, rerender } = render(createElement(Hosted, props))
    unmounts.push(unmount)
    const option = [...container.querySelectorAll("button")].find((each) =>
      each.textContent?.includes("No, and tell"),
    )!
    act(() => void option.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    set(container.querySelector("textarea.chat-field")!, "use pnpm")
    const send = [...container.querySelectorAll("button")].find((each) =>
      each.textContent?.includes("Send answer"),
    )!
    act(() => void send.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    // The runner marks the request done: the card goes, then the failure arrives.
    act(() => store.update((conversation) => ({ ...conversation, requests: [] })))
    expect(container.querySelector(".chat-request")).toBeNull()
    await act(async () => failures[0]!(new WordsLost()))
    expect(onWordsLost).toHaveBeenCalledWith("use pnpm")
    expect(container.querySelector(".chat-lost")?.textContent).toContain("They're in the box")
    // Sent from the box as it is, without editing: the notice goes.
    rerender(createElement(Hosted, { ...props, draft: "use pnpm" }))
    const sendDraft = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
    await act(async () => void sendDraft.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(container.querySelector(".chat-lost")).toBeNull()
  })

  it("keeps the notice when more words came back while a send was under way", async () => {
    const store = createStore<Conversation>(asking)
    const failures: ((failure: unknown) => void)[] = []
    const sends: (() => void)[] = []
    const props = {
      conversation: store,
      terminalName: "T",
      program: "claude",
      agent: undefined,
      compact: false,
      draft: "first",
      onDraft: () => {},
      onDraftSent: () => {},
      onSend: () => new Promise<void>((resolve) => sends.push(resolve)),
      onInterrupt: async () => {},
      onAnswer: () => new Promise<void>((_resolve, reject) => failures.push(reject)),
      onWordsLost: () => {},
      onAnswerInTerminal: () => {},
      focusInput: false,
      onInputFocused: () => {},
    }
    const { container, unmount } = render(createElement(Hosted, props))
    unmounts.push(unmount)
    const click = (label: string): void => {
      const target = [...container.querySelectorAll("button")].find((each) =>
        each.textContent?.includes(label),
      )!
      act(() => void target.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    }
    const answerWith = (words: string): void => {
      click("No, and tell")
      set(container.querySelector("textarea.chat-field")!, words)
      click("Send answer")
    }
    answerWith("one")
    await act(async () => failures[0]!(new WordsLost()))
    expect(container.querySelector(".chat-lost")).not.toBeNull()
    // A send begins, and before it ends another answer's words come back.
    act(() => void container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click())
    act(() => store.update(() => asking))
    answerWith("two")
    await act(async () => failures[1]!(new WordsLost()))
    await act(async () => sends[0]!())
    expect(container.querySelector(".chat-lost")).not.toBeNull()
  })
})

const questioning: Conversation = {
  ...noConversation,
  agent: "agy",
  session: "s",
  loaded: true,
  requests: [
    {
      id: "r1",
      kind: "question",
      tool: "ask_question",
      subject: null,
      choices: [],
      subagent: false,
      answered: false,
      dialog: {
        type: "questions",
        id: "q1",
        chat: "field",
        questions: [
          {
            id: "a",
            header: null,
            question: "Which?",
            options: [{ id: "x", label: "X", description: null }],
            multiSelect: false,
            text: true,
          },
        ],
      },
    },
  ],
}

const replyProps = (store: ReturnType<typeof createStore<Conversation>>, draft: string) => ({
  conversation: store,
  terminalName: "T",
  program: "agy",
  agent: undefined,
  compact: false,
  draft,
  onDraft: () => {},
  onDraftSent: vi.fn<(text: string) => void>(),
  onSend: vi.fn<(text: string) => Promise<void>>(async () => {}),
  onInterrupt: async () => {},
  onAnswer: vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(async () => {}),
  onWordsLost: () => {},
  onAnswerInTerminal: () => {},
  focusInput: false,
  onInputFocused: () => {},
})
const button = (container: HTMLElement, label: string): HTMLButtonElement =>
  [...container.querySelectorAll("button")].find((each) => each.textContent?.includes(label))!

const press = (container: HTMLElement, label: string): void =>
  act(() => void button(container, label).dispatchEvent(new MouseEvent("click", { bubbles: true })))

describe("a chat about the agent's question, where its own field takes the words", () => {
  it("turns the box into the reply, whose send answers with its words on one line", async () => {
    const store = createStore<Conversation>(questioning)
    const shown = replyProps(store, "/why\nthis one")
    const { container, unmount } = render(createElement(Hosted, shown))
    unmounts.push(unmount)
    press(container, "Chat about this")
    expect(container.querySelector('input[type="radio"]')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector(".chat-input"))
    const note = container.querySelector(".chat-reply")!
    expect(note.textContent).toContain("Replying to")
    const box = container.querySelector<HTMLTextAreaElement>(".chat-input")!
    expect(box.getAttribute("aria-describedby")).toContain(note.id)
    expect(box.maxLength).toBe(16_384)
    // The agent's field takes a leading slash; it isn't a prompt.
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
    expect(send.disabled).toBe(false)
    await act(async () => void send.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(shown.onAnswer).toHaveBeenCalledWith("r1", {
      type: "chat",
      dialog: "q1",
      text: "/why this one",
    })
    expect(shown.onSend).not.toHaveBeenCalled()
    expect(shown.onDraftSent).toHaveBeenCalledWith("/why\nthis one")
    expect(container.querySelector(".chat-reply")).toBeNull()
  })

  it("goes back to a plain message once cancelled, or once the dialog goes", () => {
    const store = createStore<Conversation>(questioning)
    const { container, unmount } = render(createElement(Hosted, replyProps(store, "hi")))
    unmounts.push(unmount)
    press(container, "Chat about this")
    press(container, "Cancel")
    expect(container.querySelector(".chat-reply")).toBeNull()
    expect(container.querySelector('input[type="radio"]')).not.toBeNull()
    press(container, "Chat about this")
    expect(container.querySelector(".chat-reply")).not.toBeNull()
    act(() => store.update((conversation) => ({ ...conversation, requests: [] })))
    // Its words stay, held as no longer a reply.
    expect(container.querySelector(".chat-reply")?.textContent).toContain("no longer a reply")
    expect(container.querySelector("textarea")?.getAttribute("placeholder")).toBe(
      "Message Antigravity…",
    )
  })
})

describe("a chat about the agent's question, where its words go on as a prompt", () => {
  it("gives the box focus once the questions went aside, the card still showing", async () => {
    const finishers: (() => void)[] = []
    const store = createStore<Conversation>({
      ...questioning,
      agent: "claude",
      requests: questioning.requests.map((request) =>
        request.dialog?.type === "questions"
          ? { ...request, dialog: { ...request.dialog, chat: "prompt" as const } }
          : request,
      ),
    })
    const shown = {
      ...replyProps(store, ""),
      onAnswer: vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(
        () => new Promise<void>((resolve) => finishers.push(resolve)),
      ),
    }
    const { container, unmount } = render(createElement(Hosted, shown))
    unmounts.push(unmount)
    const chat = [...container.querySelectorAll("button")].find((each) =>
      each.textContent?.includes("Chat about this"),
    )!
    act(() => void chat.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(shown.onAnswer).toHaveBeenCalledWith("r1", { type: "chat", dialog: "q1" })
    chat.focus()
    await act(async () => finishers[0]!())
    expect(container.querySelector(".chat-request")).not.toBeNull()
    expect(document.activeElement).toBe(container.querySelector(".chat-input"))
  })
})

describe("a shell command sent to an agent that keeps no record of it", () => {
  it("says its output shows only in the terminal, until the person types again", async () => {
    const store = createStore<Conversation>({ ...questioning, requests: [] })
    const shown = replyProps(store, "!ls")
    const { container, unmount, rerender } = render(createElement(Hosted, shown))
    unmounts.push(unmount)
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
    await act(async () => void send.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(shown.onSend).toHaveBeenCalledWith("!ls")
    expect(container.querySelector(".chat-unrecorded")?.textContent).toContain("keeps no record")
    set(container.querySelector<HTMLTextAreaElement>(".chat-input")!, "next")
    rerender(createElement(Hosted, { ...shown, draft: "next" }))
    expect(container.querySelector(".chat-unrecorded")).toBeNull()
  })

  it("says nothing of a message, or where the agent records the command", async () => {
    const quiet = async (conversation: Conversation, draft: string): Promise<void> => {
      const store = createStore<Conversation>(conversation)
      const { container, unmount } = render(createElement(Hosted, replyProps(store, draft)))
      unmounts.push(unmount)
      const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
      await act(async () => void send.dispatchEvent(new MouseEvent("click", { bubbles: true })))
      expect(container.querySelector(".chat-unrecorded")).toBeNull()
    }
    await quiet({ ...questioning, requests: [] }, "hello")
    await quiet({ ...questioning, agent: "claude", requests: [] }, "!ls")
  })
})

describe("a reply to the agent's question, as its dialog changes", () => {
  const withDialog = (id: string | null): Conversation => ({
    ...questioning,
    requests:
      id === null
        ? []
        : questioning.requests.map((request) =>
            request.dialog?.type === "questions"
              ? { ...request, dialog: { ...request.dialog, id } }
              : request,
          ),
  })
  it("ends for good once the dialog changes, though it reads as before again", () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const { container, unmount } = render(createElement(Hosted, replyProps(store, "")))
    unmounts.push(unmount)
    press(container, "Chat about this")
    expect(container.querySelector(".chat-reply")?.textContent).toContain("Replying to")
    act(() => store.update(() => withDialog("q2")))
    act(() => store.update(() => withDialog("q1")))
    expect(container.querySelector(".chat-reply")).toBeNull()
    expect(container.querySelector('input[type="radio"]')).not.toBeNull()
  })

  it("holds words written as a reply once the question goes, until the person edits them", async () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const shown = replyProps(store, "!important: pick X")
    const { container, unmount, rerender } = render(createElement(Hosted, shown))
    unmounts.push(unmount)
    press(container, "Chat about this")
    act(() => store.update(() => withDialog(null)))
    expect(container.querySelector(".chat-reply")?.textContent).toContain("no longer a reply")
    const send = () => container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
    expect(send().disabled).toBe(true)
    const box = container.querySelector<HTMLTextAreaElement>(".chat-input")!
    await act(
      async () =>
        void box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    )
    expect(shown.onSend).not.toHaveBeenCalled()
    expect(shown.onAnswer).not.toHaveBeenCalled()
    // Edited, it is a message again: here a shell command, said as one.
    set(box, "!important")
    rerender(createElement(Hosted, { ...shown, draft: "!important" }))
    expect(container.querySelector(".chat-reply")?.textContent).toContain("Runs in")
    expect(send().disabled).toBe(false)
  })

  it("refuses a reply past what the agent's field takes, saying so", () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const { container, unmount } = render(
      createElement(Hosted, replyProps(store, "x".repeat(16_385))),
    )
    unmounts.push(unmount)
    press(container, "Chat about this")
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(
      true,
    )
    expect(container.textContent).toContain("at most 16,384 characters")
  })

  it("stays a reply after one that failed, its card free again, the failure said", async () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const shown = {
      ...replyProps(store, "why"),
      onAnswer: vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(async () => {
        throw new Error("Couldn't answer for the agent.")
      }),
    }
    const { container, unmount } = render(createElement(Hosted, shown))
    unmounts.push(unmount)
    press(container, "Chat about this")
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
    await act(async () => void send.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(container.querySelector(".chat-reply")?.textContent).toContain("Replying to")
    expect(container.textContent).toContain("Couldn't answer for the agent.")
    expect(button(container, "Back to the questions").disabled).toBe(false)
  })

  it("announces the note of an unrecorded shell command from a status already in the page", async () => {
    const store = createStore<Conversation>(withDialog(null))
    const { container, unmount } = render(createElement(Hosted, replyProps(store, "!ls")))
    unmounts.push(unmount)
    const region = [...container.querySelectorAll('[role="status"]')].find(
      (each) => each.childElementCount === 0 && each.tagName === "DIV",
    )
    expect(region).toBeDefined()
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
    await act(async () => void send.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(region!.textContent).toContain("keeps no record")
  })

  it("takes words held from a reply whose question went as a new reply's own", () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const { container, unmount } = render(createElement(Hosted, replyProps(store, "pick X")))
    unmounts.push(unmount)
    press(container, "Chat about this")
    act(() => store.update(() => withDialog(null)))
    expect(container.querySelector(".chat-reply")?.textContent).toContain("no longer a reply")
    act(() => store.update(() => withDialog("q2")))
    press(container, "Chat about this")
    const notes = [...container.querySelectorAll(".chat-reply")].map((each) => each.textContent)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("Replying to")
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(
      false,
    )
  })

  it("keeps a reply, or the hold on its words, when the chat leaves the screen and comes back", () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const shown = replyProps(store, "!important: pick X")
    const { container, unmount, rerender } = render(createElement(Hosted, shown))
    unmounts.push(unmount)
    press(container, "Chat about this")
    // "Answer in terminal": the chat goes, and comes back with the question still asked.
    rerender(createElement(Hosted, { ...shown, mounted: false }))
    rerender(createElement(Hosted, shown))
    expect(container.querySelector(".chat-reply")?.textContent).toContain("Replying to")
    // Gone again, and the question answered in the terminal meanwhile.
    rerender(createElement(Hosted, { ...shown, mounted: false }))
    act(() => store.update(() => withDialog(null)))
    rerender(createElement(Hosted, shown))
    expect(container.querySelector(".chat-reply")?.textContent).toContain("no longer a reply")
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(
      true,
    )
    // And the hold itself outlives another round.
    rerender(createElement(Hosted, { ...shown, mounted: false }))
    rerender(createElement(Hosted, shown))
    expect(container.querySelector(".chat-reply")?.textContent).toContain("no longer a reply")
    expect(shown.onSend).not.toHaveBeenCalled()
  })

  it("resumes a reply on a chat back on screen before its conversation was read again", async () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const shown = replyProps(store, "the second one")
    const { container, unmount, rerender } = render(createElement(Hosted, shown))
    unmounts.push(unmount)
    press(container, "Chat about this")
    rerender(createElement(Hosted, { ...shown, mounted: false }))
    // Unwatched a while, the conversation is let go, and read again once the chat is back.
    act(() => store.update(() => noConversation))
    rerender(createElement(Hosted, shown))
    // Still a reply while it reads, and nothing goes meanwhile.
    expect(container.querySelector(".chat-reply")?.textContent).toContain("Replying to")
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
    await act(async () => void send.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(shown.onSend).not.toHaveBeenCalled()
    expect(shown.onAnswer).not.toHaveBeenCalled()
    expect(container.textContent).toContain("still loading")
    act(() => store.update(() => withDialog("q1")))
    expect(container.querySelector(".chat-reply")?.textContent).toContain("Replying to")
  })
})
