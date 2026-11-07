import {
  WordsLost,
  noConversation,
  type ChatAnswer,
  type ChatItem,
  type ChatPrompt,
  type Conversation,
  type Conversations,
  type SendResult,
} from "@novadeck/core/conversation"
import { createStore, type Store } from "@novadeck/core/store"
import { refusing } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { ChatView } from "./ChatView"
import { createChatCommands } from "./commands"
import { chatDraftOf, chatReplyOf, chatSendsOf, createChat } from "./state"
import { describe, expect, it } from "./test"
import { useChat } from "./use-chat"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const key = { projectId: "project", workspaceSessionId: "initial", terminalId: "01" }
const context = "project/initial"

// The chat as the app holds it: its draft, what the draft replies to and the words on their
// way kept in the chat's own store by its real commands, which send to `send` and `answer` as
// the backend would, so they outlive the chat leaving the screen (`show(false)`).
const inApp = (
  conversation: Store<Conversation>,
  {
    draft = "",
    program = "claude",
    send = async () => {},
    answer = async () => {},
    onRef = () => {},
    onKeys,
  }: {
    readonly draft?: string
    readonly program?: string
    readonly onKeys?: (keys: string) => Promise<void>
    readonly send?: (text: string) => Promise<SendResult | void>
    readonly answer?: (request: string, answer: ChatAnswer) => Promise<void>
    readonly onRef?: (ref: string) => void
  } = {},
) => {
  const sent = vi.fn<(text: string) => Promise<SendResult | void>>(send)
  const answered = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(answer)
  const conversations: Conversations = {
    conversation: () => conversation,
    send: (_key, text, options) => {
      if (options?.ref) onRef(options.ref)
      return sent(text)
    },
    interrupt: async () => null,
    answer: (_key, request, reply) => answered(request, reply),
    refused: refusing(),
  }
  const chat = createChat()
  const commands = createChatCommands({
    chatView: () => true,
    chat,
    conversations,
    terminalOpen: () => true,
    context: () => context,
  })
  commands.setChatDraft("01", draft)
  const App = ({ mounted }: { readonly mounted: boolean }): React.JSX.Element | null => {
    const state = useChat(chat, (each) => each)
    return mounted
      ? createElement(ChatView, {
          conversation,
          terminalName: "T",
          program,
          agent: undefined,
          compact: false,
          draft: chatDraftOf(state.drafts, context, "01"),
          onDraft: (text) => commands.setChatDraft("01", text),
          replyTo: chatReplyOf(state.replies, context, "01"),
          onReplyTo: (to) => commands.setChatReply(context, "01", to),
          sending: chatSendsOf(state.sends, context, "01"),
          onSend: (text, to) => commands.sendChat(key, text, to),
          onInterrupt: async () => {},
          onAnswer: (request, reply) => conversations.answer(key, request, reply),
          onWordsLost: (words) => commands.appendChatDraft(context, "01", words),
          onAnswerInTerminal: () => {},
          focusInput: false,
          onInputFocused: () => {},
          refused: conversations.refused,
          ...(onKeys && { onKeys }),
        })
      : null
  }
  const { container, unmount, rerender } = render(createElement(App, { mounted: true }))
  unmounts.push(unmount)
  return {
    container,
    sent,
    answered,
    show: (mounted: boolean) => rerender(createElement(App, { mounted })),
    draft: () => chatDraftOf(chat.store.getSnapshot().drafts, context, "01"),
    replyTo: () => chatReplyOf(chat.store.getSnapshot().replies, context, "01"),
    stop: () => act(() => commands.stopChat(key)),
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

// The person's prompts shown before the record has them: their words, state and note.
const bubbles = (container: HTMLElement): (string | null)[][] =>
  [...container.querySelectorAll<HTMLElement>(".chat-message[data-sent]")].map((each) => [
    each.querySelector(".chat-text")?.textContent ?? null,
    each.dataset.sent ?? null,
    each.querySelector(".chat-sent")?.textContent ?? null,
  ])

const userItem = (text: string): ChatItem => ({
  id: "s:0",
  at: null,
  role: "user",
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
})

const box = (container: HTMLElement): HTMLTextAreaElement =>
  container.querySelector<HTMLTextAreaElement>(".chat-input")!

describe("a chat whose answer's words didn't reach the agent", () => {
  it("hands the words back and says so, though the card went before the failure came", async () => {
    const store = createStore<Conversation>(asking)
    const failures: ((failure: unknown) => void)[] = []
    const chat = inApp(store, {
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
    const { container } = inApp(store, {
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

describe("a chat over a harness's own menu", () => {
  const talking: Conversation = {
    ...noConversation,
    agent: "claude",
    session: "s",
    loaded: true,
  }
  const open = (given: Conversation = talking) => {
    const conversation = createStore(given)
    const keys: string[] = []
    const app = inApp(conversation, {
      onKeys: async (written) => {
        keys.push(written)
      },
    })
    const field = app.container.querySelector("textarea")!
    const down = (name: string): void =>
      void act(() => {
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
        )
      })
    return { ...app, conversation, keys, field, down }
  }

  it("passes a leading / to the terminal rather than refuse it", () => {
    const { field, keys, container, sent } = open()
    set(field, "/")
    set(field, "/m")
    expect(keys).toEqual(["/", "m"])
    expect(container.textContent).toContain("own menu")
    expect(sent).not.toHaveBeenCalled()
  })

  it("sends Enter to the terminal, and echoes the command as the person's words", () => {
    const { field, keys, down, container, sent } = open()
    set(field, "/status")
    down("Enter")
    expect(keys).toEqual(["/status", "\r"])
    expect(sent).not.toHaveBeenCalled()
    expect(container.querySelector(".chat-echo")?.textContent).toBe("/status")
  })

  it("follows the terminal's program before a session binds", () => {
    const conversation = createStore(noConversation)
    const keys: string[] = []
    const { container } = inApp(conversation, {
      program: "codex",
      onKeys: async (written) => {
        keys.push(written)
      },
    })
    set(container.querySelector("textarea")!, "/")
    expect(keys).toEqual(["/"])
  })

  it("passes a menu's keys only while one shows", () => {
    const { field, keys, down, conversation } = open()
    set(field, "/")
    down("ArrowDown")
    down("Escape")
    expect(keys).toEqual(["/"])
    act(() =>
      conversation.update((current) => ({
        ...current,
        slice: { reason: "menu", columns: 80, rows: [[]], cursor: null, secret: false },
      })),
    )
    down("ArrowDown")
    down("Escape")
    expect(keys).toEqual(["/", "\x1b[B", "\x1b"])
  })

  it("takes a plain message as it always did", () => {
    const { field, keys, down, sent } = open()
    set(field, "hello there")
    down("Enter")
    expect(keys).toEqual([])
    expect(sent).toHaveBeenCalled()
  })

  it("draws the terminal's own rows, and hands the keys to a view", () => {
    const { conversation, keys, container } = open()
    act(() =>
      conversation.update((current) => ({
        ...current,
        slice: { reason: "view", columns: 80, rows: [[]], cursor: null, secret: false },
      })),
    )
    const rows = container.querySelector<HTMLElement>(".chat-slice")!
    expect(document.activeElement).toBe(rows)
    act(() => {
      rows.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(keys).toEqual(["\x1b"])
    act(() => conversation.update((current) => ({ ...current, slice: null })))
    expect(document.activeElement).toBe(container.querySelector("textarea"))
  })
})

describe("a chat sending a message", () => {
  it("takes it out of the box as it goes, and queues the next one behind it", async () => {
    const sends: (() => void)[] = []
    const chat = inApp(createStore<Conversation>({ ...asking, requests: [] }), {
      draft: "first",
      send: () => new Promise<void>((resolve) => sends.push(resolve)),
    })
    const { container } = chat
    await send(container)
    expect(chat.sent).toHaveBeenCalledWith("first")
    expect(box(container).value).toBe("")
    expect(box(container).readOnly).toBe(false)
    expect(bubbles(container)).toEqual([["first", "sending", "Sending…"]])
    set(box(container), "second")
    expect(sendButton(container).disabled).toBe(false)
    await send(container)
    expect(chat.sent).toHaveBeenCalledTimes(1)
    expect(box(container).value).toBe("")
    expect(bubbles(container)).toEqual([
      ["first", "sending", "Sending…"],
      ["second", "queued", "Queued"],
    ])
    // A backend that follows no prompts: the next goes once the one before went.
    await act(async () => sends[0]!())
    expect(chat.sent).toHaveBeenLastCalledWith("second")
    expect(bubbles(container)).toEqual([["second", "sending", "Sending…"]])
  })

  it("holds the next one until the agent's record has the one before, where the backend tells", async () => {
    const conversation = createStore<Conversation>({ ...asking, requests: [] })
    const refs: string[] = []
    const chat = inApp(conversation, {
      draft: "first",
      send: async () => ({ tracked: true }),
      onRef: (ref) => refs.push(ref),
    })
    const { container } = chat
    await send(container)
    set(box(container), "second")
    await send(container)
    expect(chat.sent).toHaveBeenCalledTimes(1)
    const receipt = (state: ChatPrompt["state"], item: number | null = null): ChatPrompt => ({
      ref: refs[0]!,
      text: state === "pending" ? "first" : null,
      sentAt: 1,
      state,
      item,
    })
    await act(async () => conversation.update((now) => ({ ...now, prompts: [receipt("pending")] })))
    expect(chat.sent).toHaveBeenCalledTimes(1)
    await act(async () =>
      conversation.update((now) => ({ ...now, prompts: [receipt("settled", 0)] })),
    )
    expect(chat.sent).toHaveBeenLastCalledWith("second")
    // Settled, but its item yet to arrive: it shows as on its way until it does.
    expect(bubbles(container)[0]).toEqual(["first", "sending", "Sending…"])
    await act(async () => conversation.update((now) => ({ ...now, items: [userItem("first")] })))
    expect(bubbles(container).map(([text]) => text)).toEqual(["second"])
  })

  it("says so when the agent's record never got it, and offers the terminal", async () => {
    const conversation = createStore<Conversation>({
      ...asking,
      requests: [],
      prompts: [
        { ref: "abcdefghijklmnop", text: "lost words", sentAt: 1, state: "unrecorded", item: null },
        { ref: "bcdefghijklmnopq", text: "boxed words", sentAt: 2, state: "in-box", item: null },
        { ref: "cdefghijklmnopqr", text: null, sentAt: 3, state: "withdrawn", item: null },
      ],
    })
    const { container } = inApp(conversation)
    expect(bubbles(container)).toEqual([
      ["lost words", "unrecorded", "Sent, but not in the agent's record.Show terminal"],
      ["boxed words", "in-box", "It's back in Claude's box in the terminal.Show terminal"],
    ])
  })

  it("puts it back before what was typed meanwhile when it doesn't go, saying why", async () => {
    const failures: ((failure: unknown) => void)[] = []
    const chat = inApp(createStore<Conversation>({ ...asking, requests: [] }), {
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
    const chat = inApp(createStore<Conversation>({ ...asking, requests: [] }), {
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
    const chat = inApp(createStore<Conversation>(questioning), {
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
    const { container } = inApp(store, { draft: "hi", program: "agy" })
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
    const chat = inApp(store, {
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
    const chat = inApp(createStore<Conversation>({ ...questioning, requests: [] }), {
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
    const quiet = async (
      conversation: Conversation,
      draft: string,
      program = "claude",
    ): Promise<void> => {
      const { container } = inApp(createStore<Conversation>(conversation), { draft, program })
      await send(container)
      expect(container.querySelector(".chat-unrecorded")).toBeNull()
    }
    await quiet({ ...questioning, requests: [] }, "hello")
    await quiet({ ...questioning, agent: "claude", requests: [] }, "!ls")
    // The conversation's harness says, not the program the terminal runs.
    await quiet({ ...questioning, agent: null, requests: [] }, "!ls", "agy")
  })

  it("says nothing of one handed back unsent, at a Stop or behind a prompt that didn't go", async () => {
    // `!ls` queued behind `go`, which is still being typed.
    const queue = (sending: (text: string) => Promise<SendResult | void>) => {
      const chat = inApp(createStore<Conversation>({ ...questioning, requests: [] }), {
        draft: "go",
        program: "agy",
        send: sending,
      })
      return send(chat.container)
        .then(() => set(box(chat.container), "!ls"))
        .then(() => send(chat.container))
        .then(() => chat)
    }
    const stopped = await queue(() => new Promise<void>(() => {}))
    await stopped.stop()
    expect(stopped.draft()).toBe("!ls")
    expect(stopped.container.querySelector(".chat-unrecorded")).toBeNull()

    const failures: ((failure: unknown) => void)[] = []
    const failed = await queue(() => new Promise<void>((_resolve, reject) => failures.push(reject)))
    await act(async () => failures[0]!(new Error("The runner is offline.")))
    expect(failed.draft()).toBe("go\n!ls")
    expect(failed.container.querySelector(".chat-unrecorded")).toBeNull()
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
    const { container } = inApp(store, { program: "agy" })
    press(container, "Chat about this")
    expect(container.querySelector(".chat-reply")?.textContent).toContain("Replying to")
    act(() => store.update(() => withDialog("q2")))
    act(() => store.update(() => withDialog("q1")))
    expect(container.querySelector(".chat-reply")).toBeNull()
    expect(container.querySelector('input[type="radio"]')).not.toBeNull()
  })

  it("holds words written as a reply once the question goes, until the person edits them", async () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const chat = inApp(store, { draft: "!important: pick X", program: "agy" })
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

  it("holds words typed while the reply went, once it took", async () => {
    const lands: (() => void)[] = []
    const chat = inApp(createStore<Conversation>(questioning), {
      draft: "pick X",
      program: "agy",
      answer: () => new Promise<void>((resolve) => lands.push(resolve)),
    })
    const { container } = chat
    press(container, "Chat about this")
    await send(container)
    set(box(container), "and then Y")
    expect(container.querySelector(".chat-reply")?.textContent).toContain("Replying")
    await act(async () => lands[0]!())
    expect(chat.replyTo()).toBe("held")
    expect(chat.draft()).toBe("and then Y")
    expect(container.querySelector(".chat-reply")?.textContent).toContain("no longer a reply")
  })

  it("lets an edit release words held while an unrelated message is on its way", async () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const sends: (() => void)[] = []
    const chat = inApp(store, {
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
    const chat = inApp(store, {
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
    const { container } = inApp(createStore<Conversation>(withDialog("q1")), {
      draft: "x".repeat(16_385),
      program: "agy",
    })
    press(container, "Chat about this")
    expect(sendButton(container).disabled).toBe(true)
    expect(container.textContent).toContain("at most 16,384 characters")
  })

  it("stays a reply after one that failed, its words back and its card free again, the failure said", async () => {
    const chat = inApp(createStore<Conversation>(withDialog("q1")), {
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
    const { container } = inApp(createStore<Conversation>(withDialog(null)), {
      draft: "!ls",
      program: "agy",
    })
    const region = [...container.querySelectorAll('[role="status"]')].find(
      (each) =>
        each.childElementCount === 0 &&
        each.tagName === "DIV" &&
        !each.classList.contains("chat-unread-region"),
    )
    expect(region).toBeDefined()
    await send(container)
    expect(region!.textContent).toContain("keeps no record")
  })

  it("takes words held from a reply whose question went as a new reply's own", () => {
    const store = createStore<Conversation>(withDialog("q1"))
    const { container } = inApp(store, { draft: "pick X", program: "agy" })
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
    const chat = inApp(store, { draft: "!important: pick X", program: "agy" })
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
    const chat = inApp(store, { draft: "the second one", program: "agy" })
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

describe("parts of the conversation the chat can't read", () => {
  const notice = (container: HTMLElement): string | null =>
    container.querySelector(".chat-unread")?.textContent ?? null
  const action = (container: HTMLElement, name: string): HTMLButtonElement =>
    [...container.querySelectorAll<HTMLButtonElement>(".chat-unread button")].find(
      (each) => each.textContent === name,
    )!

  it("tells once at the top, until dismissed, for the session alone", () => {
    const session = `s-${crypto.randomUUID()}`
    const conversation = createStore<Conversation>({
      ...noConversation,
      agent: "claude",
      session,
      loaded: true,
      unread: true,
    })
    const chat = inApp(conversation)
    expect(notice(chat.container)).toContain(
      "This chat may be missing parts of the conversation. The terminal has all of it.",
    )
    // Above the thread, in a region mounted while empty so a screen reader announces it.
    const region = chat.container.querySelector(".chat")?.firstElementChild
    expect(region?.getAttribute("role")).toBe("status")
    expect(region?.firstElementChild?.className).toBe("chat-unread")
    expect(action(chat.container, "Show terminal")).toBeDefined()
    act(() => action(chat.container, "Dismiss").click())
    expect(notice(chat.container)).toBeNull()
    // The chat leaving the screen and coming back, as the person visits the terminal.
    chat.show(false)
    chat.show(true)
    expect(notice(chat.container)).toBeNull()
    // Another session in the terminal tells its own.
    act(() => void conversation.update((current) => ({ ...current, session: `${session}-next` })))
    expect(notice(chat.container)).not.toBeNull()
  })

  it("says nothing where the record holds nothing it can't read", () => {
    const { container } = inApp(
      createStore<Conversation>({ ...noConversation, agent: "claude", session: "s", loaded: true }),
    )
    expect(notice(container)).toBeNull()
  })
})
