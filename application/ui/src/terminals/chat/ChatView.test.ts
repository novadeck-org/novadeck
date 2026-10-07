import { act, createElement, useSyncExternalStore } from "react"
import { afterEach, vi } from "vitest"

import {
  WordsLost,
  noConversation,
  type ChatAnswer,
  type Conversation,
  type Conversations,
} from "../../model/conversation"
import { createStore, type Store } from "../../model/store"
import { describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"
import { refusing } from "../../test/fixtures"
import { render } from "../../test/render"
import { ChatView } from "./ChatView"
import { chatDraftOf, chatReplyOf, chatSendOf } from "./mode-state"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const key = { projectId: "project", workspaceSessionId: "initial", terminalId: "01" }
const context = "project/initial"

// The chat as the app holds it: its draft, what the draft replies to and the words on their
// way kept in the UI store by the real commands, which send to `send` and `answer` as the
// backend would, so they outlive the chat leaving the screen (`show(false)`).
const host = (
  conversation: Store<Conversation>,
  {
    draft = "",
    program = "claude",
    send = async () => {},
    answer = async () => {},
  }: {
    readonly draft?: string
    readonly program?: string
    readonly send?: (text: string) => Promise<void>
    readonly answer?: (request: string, answer: ChatAnswer) => Promise<void>
  } = {},
) => {
  const sent = vi.fn<(text: string) => Promise<void>>(send)
  const answered = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(answer)
  const conversations: Conversations = {
    conversation: () => conversation,
    send: (_key, text) => sent(text),
    interrupt: async () => null,
    answer: (_key, request, reply) => answered(request, reply),
    refused: refusing(),
  }
  const app = openCommands({ conversations })
  app.commands.setChatDraft("01", draft)
  const Hosted = ({ mounted }: { readonly mounted: boolean }): React.JSX.Element | null => {
    const ui = useSyncExternalStore(app.ui.subscribe, app.ui.getSnapshot)
    return mounted
      ? createElement(ChatView, {
          conversation,
          terminalName: "T",
          program,
          agent: undefined,
          compact: false,
          draft: chatDraftOf(ui.chatDrafts, context, "01"),
          onDraft: (text) => app.commands.setChatDraft("01", text),
          replyTo: chatReplyOf(ui.chatReplies, context, "01"),
          onReplyTo: (to) => app.commands.setChatReply(context, "01", to),
          sending: chatSendOf(ui.chatSends, context, "01"),
          onSend: (text, to) => app.commands.sendChat(key, text, to),
          onInterrupt: async () => {},
          onAnswer: (request, reply) => conversations.answer(key, request, reply),
          onWordsLost: (words) => app.commands.appendChatDraft(context, "01", words),
          onAnswerInTerminal: () => {},
          focusInput: false,
          onInputFocused: () => {},
          refused: conversations.refused,
        })
      : null
  }
  const { container, unmount, rerender } = render(createElement(Hosted, { mounted: true }))
  unmounts.push(unmount)
  return {
    container,
    sent,
    answered,
    show: (mounted: boolean) => rerender(createElement(Hosted, { mounted })),
    draft: () => chatDraftOf(app.ui.getSnapshot().chatDrafts, context, "01"),
    replyTo: () => chatReplyOf(app.ui.getSnapshot().chatReplies, context, "01"),
  }
}

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

const button = (container: HTMLElement, label: string): HTMLButtonElement =>
  [...container.querySelectorAll("button")].find((each) => each.textContent?.includes(label))!

const press = (container: HTMLElement, label: string): void =>
  act(() => void button(container, label).dispatchEvent(new MouseEvent("click", { bubbles: true })))

const sendButton = (container: HTMLElement): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!

const send = async (container: HTMLElement): Promise<void> =>
  act(
    async () =>
      void sendButton(container).dispatchEvent(new MouseEvent("click", { bubbles: true })),
  )

const box = (container: HTMLElement): HTMLTextAreaElement =>
  container.querySelector<HTMLTextAreaElement>(".chat-input")!

describe("a chat whose answer's words didn't reach the agent", () => {
  it("hands the words back and says so, though the card went before the failure came", async () => {
    const store = createStore<Conversation>(asking)
    const failures: ((failure: unknown) => void)[] = []
    const chat = host(store, {
      answer: () => new Promise<void>((_resolve, reject) => failures.push(reject)),
    })
    const { container } = chat
    press(container, "No, and tell")
    set(container.querySelector("textarea.chat-field")!, "use pnpm")
    press(container, "Send answer")
    // The runner marks the request done: the card goes, then the failure arrives.
    act(() => store.update((conversation) => ({ ...conversation, requests: [] })))
    expect(container.querySelector(".chat-request")).toBeNull()
    await act(async () => failures[0]!(new WordsLost()))
    expect(chat.draft()).toBe("use pnpm")
    expect(container.querySelector(".chat-lost")?.textContent).toContain("They're in the box")
    // Sent from the box as it is, without editing: the notice goes.
    await send(container)
    expect(chat.sent).toHaveBeenCalledWith("use pnpm")
    expect(container.querySelector(".chat-lost")).toBeNull()
  })

  it("keeps the notice when more words came back while a send was under way", async () => {
    const store = createStore<Conversation>(asking)
    const failures: ((failure: unknown) => void)[] = []
    const sends: (() => void)[] = []
    const { container } = host(store, {
      draft: "first",
      send: () => new Promise<void>((resolve) => sends.push(resolve)),
      answer: () => new Promise<void>((_resolve, reject) => failures.push(reject)),
    })
    const answerWith = (words: string): void => {
      press(container, "No, and tell")
      set(container.querySelector("textarea.chat-field")!, words)
      press(container, "Send answer")
    }
    answerWith("one")
    await act(async () => failures[0]!(new WordsLost()))
    expect(container.querySelector(".chat-lost")).not.toBeNull()
    // A send begins, and before it ends another answer's words come back.
    await send(container)
    act(() => store.update(() => asking))
    answerWith("two")
    await act(async () => failures[1]!(new WordsLost()))
    await act(async () => sends[0]!())
    expect(container.querySelector(".chat-lost")).not.toBeNull()
  })
})

describe("a chat sending a message", () => {
  it("takes it out of the box as it goes, the box free for the next one, which waits to be sent", async () => {
    const sends: (() => void)[] = []
    const chat = host(createStore<Conversation>({ ...asking, requests: [] }), {
      draft: "first",
      send: () => new Promise<void>((resolve) => sends.push(resolve)),
    })
    const { container } = chat
    await send(container)
    expect(chat.sent).toHaveBeenCalledWith("first")
    expect(box(container).value).toBe("")
    expect(box(container).readOnly).toBe(false)
    set(box(container), "second")
    expect(sendButton(container).disabled).toBe(true)
    expect(sendButton(container).getAttribute("aria-busy")).toBe("true")
    await act(async () => sends[0]!())
    expect(sendButton(container).disabled).toBe(false)
    expect(box(container).value).toBe("second")
  })

  it("puts it back before what was typed meanwhile when it doesn't go, saying why", async () => {
    const failures: ((failure: unknown) => void)[] = []
    const chat = host(createStore<Conversation>({ ...asking, requests: [] }), {
      draft: "first",
      send: () => new Promise<void>((_resolve, reject) => failures.push(reject)),
    })
    const { container } = chat
    await send(container)
    set(box(container), "second")
    await act(async () => failures[0]!(new Error("The runner is offline.")))
    expect(chat.draft()).toBe("first\nsecond")
    expect(container.querySelector(".chat-error")?.textContent).toBe("The runner is offline.")
  })

  it("leaves the box empty when it went from a chat no longer on screen", async () => {
    const sends: (() => void)[] = []
    const chat = host(createStore<Conversation>({ ...asking, requests: [] }), {
      draft: "go",
      send: () => new Promise<void>((resolve) => sends.push(resolve)),
    })
    await send(chat.container)
    chat.show(false)
    await act(async () => sends[0]!())
    chat.show(true)
    expect(box(chat.container).value).toBe("")
    expect(sendButton(chat.container).getAttribute("aria-busy")).toBeNull()
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

describe("a chat about the agent's question, where its own field takes the words", () => {
  it("turns the box into the reply, whose send answers with its words on one line", async () => {
    const chat = host(createStore<Conversation>(questioning), {
      draft: "/why\nthis one",
      program: "agy",
    })
    const { container } = chat
    press(container, "Chat about this")
    expect(container.querySelector('input[type="radio"]')).toBeNull()
    expect(document.activeElement).toBe(box(container))
    const note = container.querySelector(".chat-reply")!
    expect(note.textContent).toContain("Replying to")
    expect(box(container).getAttribute("aria-describedby")).toContain(note.id)
    expect(box(container).maxLength).toBe(16_384)
    // The agent's field takes a leading slash; it isn't a prompt.
    expect(sendButton(container).disabled).toBe(false)
    await send(container)
    expect(chat.answered).toHaveBeenCalledWith("r1", {
      type: "chat",
      dialog: "q1",
      text: "/why this one",
    })
    expect(chat.sent).not.toHaveBeenCalled()
    expect(chat.draft()).toBe("")
    expect(chat.replyTo()).toBeNull()
    expect(container.querySelector(".chat-reply")).toBeNull()
  })

  it("goes back to a plain message once cancelled, or once the dialog goes", () => {
    const store = createStore<Conversation>(questioning)
    const { container } = host(store, { draft: "hi", program: "agy" })
    press(container, "Chat about this")
    press(container, "Cancel")
    expect(container.querySelector(".chat-reply")).toBeNull()
    expect(container.querySelector('input[type="radio"]')).not.toBeNull()
    press(container, "Chat about this")
    expect(container.querySelector(".chat-reply")).not.toBeNull()
    act(() => store.update((conversation) => ({ ...conversation, requests: [] })))
    // Its words stay, held as no longer a reply.
    expect(container.querySelector(".chat-reply")?.textContent).toContain("no longer a reply")
    expect(box(container).getAttribute("placeholder")).toBe("Message Antigravity…")
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
    const chat = host(store, {
      answer: () => new Promise<void>((resolve) => finishers.push(resolve)),
    })
    const { container } = chat
    const about = button(container, "Chat about this")
    act(() => void about.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(chat.answered).toHaveBeenCalledWith("r1", { type: "chat", dialog: "q1" })
    about.focus()
    await act(async () => finishers[0]!())
    expect(container.querySelector(".chat-request")).not.toBeNull()
    expect(document.activeElement).toBe(box(container))
  })
})

describe("a shell command sent to an agent that keeps no record of it", () => {
  it("says its output shows only in the terminal, until the person types again", async () => {
    const chat = host(createStore<Conversation>({ ...questioning, requests: [] }), {
      draft: "!ls",
      program: "agy",
    })
    const { container } = chat
    await send(container)
    expect(chat.sent).toHaveBeenCalledWith("!ls")
    expect(container.querySelector(".chat-unrecorded")?.textContent).toContain("keeps no record")
    set(box(container), "next")
    expect(container.querySelector(".chat-unrecorded")).toBeNull()
  })

  it("says nothing of a message, or where the agent records the command", async () => {
    const quiet = async (conversation: Conversation, draft: string): Promise<void> => {
      const { container } = host(createStore<Conversation>(conversation), { draft })
      await send(container)
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
    const { container } = host(store, { program: "agy" })
    press(container, "Chat about this")
    expect(container.querySelector(".chat-reply")?.textContent).toContain("Replying to")
    act(() => store.update(() => withDialog("q2")))
    act(() => store.update(() => withDialog("q1")))
    expect(container.querySelector(".chat-reply")).toBeNull()
    expect(container.querySelector('input[type="radio"]')).not.toBeNull()
  })

  it("holds words written as a reply once the question goes, until the person edits them", async () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const chat = host(store, { draft: "!important: pick X", program: "agy" })
    const { container } = chat
    press(container, "Chat about this")
    act(() => store.update(() => withDialog(null)))
    expect(container.querySelector(".chat-reply")?.textContent).toContain("no longer a reply")
    expect(sendButton(container).disabled).toBe(true)
    await act(
      async () =>
        void box(container).dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        ),
    )
    expect(chat.sent).not.toHaveBeenCalled()
    expect(chat.answered).not.toHaveBeenCalled()
    // Edited, it is a message again: here a shell command, said as one.
    set(box(container), "!important")
    expect(chat.replyTo()).toBeNull()
    expect(container.querySelector(".chat-reply")?.textContent).toContain("Runs in")
    expect(sendButton(container).disabled).toBe(false)
  })

  it("lets an edit release words held while an unrelated message is on its way", async () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const sends: (() => void)[] = []
    const chat = host(store, {
      draft: "first",
      program: "agy",
      send: () => new Promise<void>((resolve) => sends.push(resolve)),
    })
    const { container } = chat
    await send(container)
    press(container, "Chat about this")
    // The reply's Cancel isn't locked by the message on its way.
    expect(button(container, "Cancel").disabled).toBe(false)
    set(box(container), "pick X")
    act(() => store.update(() => withDialog(null)))
    expect(container.querySelector(".chat-reply")?.textContent).toContain("no longer a reply")
    set(box(container), "pick X please")
    expect(chat.replyTo()).toBeNull()
    expect(container.querySelector(".chat-reply")).toBeNull()
    await act(async () => sends[0]!())
    expect(chat.replyTo()).toBeNull()
  })

  it("brings back held the words of a reply that failed after its question went, though more were typed", async () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const failures: ((failure: unknown) => void)[] = []
    const chat = host(store, {
      draft: "pick X",
      program: "agy",
      answer: () => new Promise<void>((_resolve, reject) => failures.push(reject)),
    })
    const { container } = chat
    press(container, "Chat about this")
    await send(container)
    act(() => store.update(() => withDialog(null)))
    set(box(container), "n")
    set(box(container), "ne")
    await act(async () => failures[0]!(new Error("Couldn't answer for the agent.")))
    expect(chat.draft()).toBe("pick X\nne")
    expect(chat.replyTo()).toBe("held")
    expect(sendButton(container).disabled).toBe(true)
  })

  it("refuses a reply past what the agent's field takes, saying so", () => {
    const { container } = host(createStore<Conversation>(withDialog("q1")), {
      draft: "x".repeat(16_385),
      program: "agy",
    })
    press(container, "Chat about this")
    expect(sendButton(container).disabled).toBe(true)
    expect(container.textContent).toContain("at most 16,384 characters")
  })

  it("stays a reply after one that failed, its words back and its card free again, the failure said", async () => {
    const chat = host(createStore<Conversation>(withDialog("q1")), {
      draft: "why",
      program: "agy",
      answer: async () => {
        throw new Error("Couldn't answer for the agent.")
      },
    })
    const { container } = chat
    press(container, "Chat about this")
    await send(container)
    expect(chat.draft()).toBe("why")
    expect(container.querySelector(".chat-reply")?.textContent).toContain("Replying to")
    expect(container.textContent).toContain("Couldn't answer for the agent.")
    expect(button(container, "Back to the questions").disabled).toBe(false)
  })

  it("announces the note of an unrecorded shell command from a status already in the page", async () => {
    const { container } = host(createStore<Conversation>(withDialog(null)), {
      draft: "!ls",
      program: "agy",
    })
    const region = [...container.querySelectorAll('[role="status"]')].find(
      (each) => each.childElementCount === 0 && each.tagName === "DIV",
    )
    expect(region).toBeDefined()
    await send(container)
    expect(region!.textContent).toContain("keeps no record")
  })

  it("takes words held from a reply whose question went as a new reply's own", () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const { container } = host(store, { draft: "pick X", program: "agy" })
    press(container, "Chat about this")
    act(() => store.update(() => withDialog(null)))
    expect(container.querySelector(".chat-reply")?.textContent).toContain("no longer a reply")
    act(() => store.update(() => withDialog("q2")))
    press(container, "Chat about this")
    const notes = [...container.querySelectorAll(".chat-reply")].map((each) => each.textContent)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("Replying to")
    expect(sendButton(container).disabled).toBe(false)
  })

  it("keeps a reply, or the hold on its words, when the chat leaves the screen and comes back", () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const chat = host(store, { draft: "!important: pick X", program: "agy" })
    const { container } = chat
    press(container, "Chat about this")
    // "Answer in terminal": the chat goes, and comes back with the question still asked.
    chat.show(false)
    chat.show(true)
    expect(container.querySelector(".chat-reply")?.textContent).toContain("Replying to")
    // Gone again, and the question answered in the terminal meanwhile.
    chat.show(false)
    act(() => store.update(() => withDialog(null)))
    chat.show(true)
    expect(container.querySelector(".chat-reply")?.textContent).toContain("no longer a reply")
    expect(sendButton(container).disabled).toBe(true)
    // And the hold itself outlives another round.
    chat.show(false)
    chat.show(true)
    expect(container.querySelector(".chat-reply")?.textContent).toContain("no longer a reply")
    expect(chat.sent).not.toHaveBeenCalled()
  })

  it("resumes a reply on a chat back on screen before its conversation was read again", async () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const chat = host(store, { draft: "the second one", program: "agy" })
    const { container } = chat
    press(container, "Chat about this")
    chat.show(false)
    // Unwatched a while, the conversation is let go, and read again once the chat is back.
    act(() => store.update(() => noConversation))
    chat.show(true)
    // Still a reply while it reads, and nothing goes meanwhile.
    expect(container.querySelector(".chat-reply")?.textContent).toContain("Replying to")
    await send(container)
    expect(chat.sent).not.toHaveBeenCalled()
    expect(chat.answered).not.toHaveBeenCalled()
    expect(chat.draft()).toBe("the second one")
    expect(container.textContent).toContain("still loading")
    act(() => store.update(() => withDialog("q1")))
    expect(container.querySelector(".chat-reply")?.textContent).toContain("Replying to")
  })
})
