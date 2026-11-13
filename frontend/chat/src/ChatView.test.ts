import {
  WordsLost,
  noConversation,
  noDoorbell,
  type ChatAnswer,
  type ChatItem,
  type BoxReturn,
  type ChatPrompt,
  type Conversation,
  type Conversations,
  type SendResult,
} from "@novadeck/core/conversation"
import type { AgentMessage } from "@novadeck/core/messages"
import { createStore, type Store } from "@novadeck/core/store"
import { refusing } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { ChatView } from "./ChatView"
import { createChatCommands } from "./commands"
import {
  chatAttachmentsOf,
  chatDraftOf,
  chatImageNoteOf,
  chatReplyOf,
  chatSendsOf,
  createChat,
} from "./state"
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
    upload,
    interrupt,
    takeBox,
    refuse = [],
    personFace,
  }: {
    // The person's face, as the app gives it.
    readonly personFace?: React.ReactNode
    readonly draft?: string
    readonly program?: string
    readonly onKeys?: (keys: string) => Promise<void>
    // Words the backend's rule refuses as a message.
    readonly refuse?: readonly string[]
    readonly interrupt?: () => Promise<BoxReturn>
    readonly takeBox?: () => Promise<BoxReturn>
    // Saves a pasted image, as the backend would; without it the backend takes no images.
    readonly upload?: (file: { name: string; data: Uint8Array }) => Promise<string>
    readonly send?: (text: string) => Promise<SendResult | void>
    readonly answer?: (request: string, answer: ChatAnswer) => Promise<void>
    readonly onRef?: (ref: string) => void
  } = {},
) => {
  const sent = vi.fn<(text: string) => Promise<SendResult | void>>(send)
  // The images each message went with, in order.
  const sentImages: (readonly string[] | undefined)[] = []
  // Where each went among its words.
  const sentAt: (readonly number[] | undefined)[] = []
  // Whether each set a question aside.
  const setAside: (readonly string[] | undefined)[] = []
  const answered = vi.fn<(request: string, answer: ChatAnswer) => Promise<void>>(answer)
  const conversations: Conversations = {
    conversation: () => conversation,
    send: (_key, text, options) => {
      if (options?.ref) onRef(options.ref)
      sentImages.push(options?.images)
      sentAt.push(options?.at)
      setAside.push(options?.setAside)
      return sent(text)
    },
    ...(upload && {
      uploadImage: (_key: unknown, file: { name: string; data: Uint8Array }) => upload(file),
      imageMaxBytes: 1024,
      imageTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
      maxImages: 8,
    }),
    interrupt: interrupt ?? (async () => ({ words: null })),
    ...(takeBox && { takeBox }),
    answer: (_key, request, reply) => answered(request, reply),
    refused: refusing(...refuse),
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
          attachments: chatAttachmentsOf(state.attachments, context, "01"),
          onAttach: conversations.uploadImage
            ? (files, selection) => commands.attachChatImages(key, files, selection)
            : undefined,
          onDetach: (id) => commands.removeChatImage(context, "01", id),
          onSend: (text, to, images) => commands.sendChat(key, text, to, images),
          imageNote: chatImageNoteOf(state.imageNotes, context, "01"),
          onRestore: (words, images) => commands.restoreChat(context, "01", words, images),
          onInterrupt: async () => {},
          onClearBox: async () => {},
          onAnswer: (request, reply) => conversations.answer(key, request, reply),
          onWordsLost: (words) => commands.appendChatDraft(context, "01", words),
          onAnswerInTerminal: () => {},
          focusInput: false,
          onInputFocused: () => {},
          refused: conversations.refused,
          ...(onKeys && { onKeys }),
          ...(personFace !== undefined && { personFace }),
        })
      : null
  }
  const { container, unmount, rerender } = render(createElement(App, { mounted: true }))
  unmounts.push(unmount)
  return {
    container,
    sent,
    sentImages,
    sentAt,
    setAside,
    answered,
    show: (mounted: boolean) => rerender(createElement(App, { mounted })),
    draft: () => chatDraftOf(chat.store.getSnapshot().drafts, context, "01"),
    attachments: () => chatAttachmentsOf(chat.store.getSnapshot().attachments, context, "01"),
    replyTo: () => chatReplyOf(chat.store.getSnapshot().replies, context, "01"),
    stop: () => act(() => commands.stopChat(key)),
    take: () => act(() => commands.takeBox(key)),
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
      askedAt: 0,
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

// The person's prompts shown before the record has them: their words, state, and their tag or
// what became of them.
const bubbles = (container: HTMLElement): (string | null)[][] =>
  [...container.querySelectorAll<HTMLElement>(".chat-message[data-sent]")].map((each) => {
    const tag = each.querySelector(".chat-sent-tag")?.textContent ?? null
    const text = each.querySelector(".chat-text")?.textContent ?? ""
    return [
      tag ? text.slice(0, -tag.length).trimEnd() : text,
      each.dataset.sent ?? null,
      tag ?? each.querySelector(".chat-sent")?.textContent ?? null,
    ]
  })

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
  ring: null,
})

const box = (container: HTMLElement): HTMLTextAreaElement =>
  container.querySelector<HTMLTextAreaElement>(".chat-input")!

// What a line says, without the fact at its edge.
const wordsOf = (line: Element): string =>
  [...line.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent)
    .join("")

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

  it("keeps a command's echo where it ran, above the prompts that came after it", () => {
    const { field, down, container, conversation } = open()
    set(field, "/permissions")
    down("Enter")
    act(() =>
      conversation.update((current) => ({
        ...current,
        items: [{ ...userItem("And now this"), id: "s:1", at: Date.now() + 1000 }],
      })),
    )
    const echo = container.querySelector(".chat-echo")!
    const later = container.querySelector('.chat-message[data-role="user"]')!
    expect(later.textContent).toContain("And now this")
    expect(echo.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("keeps an echo with the earlier messages while only the latest show", () => {
    const { field, down, container, conversation } = open()
    set(field, "/permissions")
    down("Enter")
    const after = Date.now() + 1000
    act(() =>
      conversation.update((current) => ({
        ...current,
        items: Array.from({ length: 80 }, (_, at) => ({
          ...userItem(`Message ${at}`),
          id: `s:${at}`,
          at: after + at,
          role: at % 2 === 0 ? ("user" as const) : ("assistant" as const),
        })),
      })),
    )
    expect(container.querySelector(".chat-earlier")).not.toBeNull()
    expect(container.querySelector(".chat-echo")).toBeNull()
    act(() => void container.querySelector<HTMLElement>(".chat-earlier")!.click())
    const echo = container.querySelector(".chat-echo")!
    const first = container.querySelector('.chat-message[data-role="user"]')!
    expect(first.textContent).toContain("Message 0")
    expect(echo.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
    expect(bubbles(container)).toEqual([["first", "sending", "sending"]])
    set(box(container), "second")
    expect(sendButton(container).disabled).toBe(false)
    await send(container)
    expect(chat.sent).toHaveBeenCalledTimes(1)
    expect(box(container).value).toBe("")
    expect(bubbles(container)).toEqual([
      ["first", "sending", "sending"],
      ["second", "queued", "queued"],
    ])
    // A backend that follows no prompts: the next goes once the one before went.
    await act(async () => sends[0]!())
    expect(chat.sent).toHaveBeenLastCalledWith("second")
    expect(bubbles(container)).toEqual([["second", "sending", "sending"]])
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
    expect(bubbles(container)[0]).toEqual(["first", "sending", "sending"])
    await act(async () => conversation.update((now) => ({ ...now, items: [userItem("first")] })))
    expect(bubbles(container).map(([text]) => text)).toEqual(["second"])
  })

  it("lets what the doorbell brought speak for itself, with a line only where it can't", async () => {
    const ring = (id: string, at: number, replies = false): ChatItem => ({
      ...userItem("[Novadeck: automatic notice, agent messages waiting, n7Q2]"),
      id,
      at,
      ring: { nonce: "n7Q2", replies },
    })
    const message = {
      id: "m-1",
      deliveredAt: 10_000,
      from: { kind: "agent", terminalId: "id-moth", handle: "moth", agent: "claude" },
      text: "Check the export job.",
    } as unknown as AgentMessage
    const conversation = createStore<Conversation>({
      ...asking,
      requests: [],
      items: [
        ring("a", 10_000),
        { ...userItem("mine"), id: "m", at: 30_000 },
        ring("b", 90_000),
        ring("c", 120_000, true),
      ],
      doorbell: { ...noDoorbell, delivered: [message] },
    })
    const { container } = inApp(conversation)
    // A message needs no line over it; a ring that brought nothing known, or a reply whose words
    // the record lacks, has one.
    expect([...container.querySelectorAll(".chat-note")].map((note) => wordsOf(note))).toEqual([
      "doorbell",
      "doorbell · your reply",
    ])
    expect(container.textContent).not.toContain("automatic notice")
    // Screen readers still hear what rang. Where the line stands, its mark is hollow: a prompt,
    // and not the person's.
    const rings = [...container.querySelectorAll('[data-role="doorbell"]')]
    expect(rings.map((each) => each.getAttribute("aria-label"))).toEqual([
      "Doorbell, 1 message",
      "Doorbell",
      "Doorbell, your reply",
    ])
    expect(rings.map((each) => each.querySelector(".chat-mark[data-hollow]") !== null)).toEqual([
      false,
      true,
      true,
    ])
    // What it brought follows in ink, under the handle that sent it.
    const brought = rings[0]!.querySelector('[data-role="agent"]')
    expect(brought?.getAttribute("aria-label")).toBe("Message from @moth")
    expect(brought?.querySelector(".chat-author")?.textContent).toBe("@moth")
    expect(brought?.querySelector(".markdown")?.textContent).toBe("Check the export job.")
    expect(rings[1]!.querySelector('[data-role="agent"]')).toBeNull()
  })

  it("shows the person's own Inbox answer the doorbell brought as theirs, not a message", () => {
    const ring: ChatItem = {
      ...userItem("[Novadeck: automatic notice, agent messages waiting, r9Q2]"),
      id: "a",
      at: 10_000,
      ring: { nonce: "r9Q2", replies: true },
    }
    const answer = {
      id: "m-2",
      deliveredAt: 10_000,
      inbox: "answer",
      from: { kind: "person" },
      text: "Use green, please.",
    } as unknown as AgentMessage
    const conversation = createStore<Conversation>({
      ...asking,
      requests: [],
      items: [ring],
      doorbell: { ...noDoorbell, delivered: [answer] },
    })
    const { container } = inApp(conversation)
    const bell = container.querySelector('[data-role="doorbell"]')!
    // Their words speak for the ring: no line over them.
    expect(bell.querySelector(".chat-note")).toBeNull()
    expect(bell.querySelector('[data-role="agent"]')).toBeNull()
    const reply = bell.querySelector('[data-role="user"]')!
    expect(reply.querySelector(".chat-mark:not([data-hollow])")).not.toBeNull()
    // Headed as an agent's message is: who, and the way it came.
    expect(reply.querySelector(".chat-author")?.textContent).toBe("you")
    expect(reply.querySelector(".chat-agent-where")?.textContent).toBe("from the Inbox")
    expect(reply.querySelector(".chat-text")?.textContent).toBe("Use green, please.")
  })

  it("puts the person's face, in their hue, at their Inbox answers, not at their prompts", () => {
    const ring: ChatItem = {
      ...userItem("[Novadeck: automatic notice, agent messages waiting, f4Q2]"),
      id: "r",
      at: 20_000,
      ring: { nonce: "f4Q2", replies: true },
    }
    const answer = {
      id: "m-3",
      deliveredAt: 20_000,
      inbox: "answer",
      from: { kind: "person" },
      text: "Yes.",
    } as unknown as AgentMessage
    const conversation = createStore<Conversation>({
      ...asking,
      requests: [],
      items: [{ ...userItem("mine"), id: "u", at: 10_000 }, ring],
      doorbell: { ...noDoorbell, delivered: [answer] },
    })
    const face = createElement("i", { className: "face" })
    const { container } = inApp(conversation, { personFace: face })
    const [prompt, inbox] = [...container.querySelectorAll('[data-role="user"]')]
    // Typed at the prompt: the mark, as ever.
    expect(prompt!.getAttribute("data-hue")).toBeNull()
    expect(prompt!.querySelector(".chat-mark")).not.toBeNull()
    expect(prompt!.querySelector(".face")).toBeNull()
    // Through the Inbox: their face, in their hue.
    expect(inbox!.getAttribute("aria-label")).toBe("You, from the Inbox")
    expect(inbox!.getAttribute("data-hue")).toBe("you")
    expect(inbox!.querySelector(".chat-person-face > .face")).not.toBeNull()
    expect(inbox!.querySelector(".chat-mark")).toBeNull()
    // Without one, the block mark there too, and no hue.
    const plain = inApp(conversation).container.querySelector(".chat-ring-reply")!
    expect(plain.getAttribute("data-hue")).toBeNull()
    expect(plain.querySelector(".chat-mark")).not.toBeNull()
  })

  it("shows no message that a Stop handed back, though the record wrote it", async () => {
    const conversation = createStore<Conversation>({
      ...asking,
      requests: [],
      items: [userItem("went"), userItem("handed back")],
      prompts: [
        { ref: "abcdefghijklmnop", text: null, sentAt: 1, state: "settled", item: 0 },
        { ref: "bcdefghijklmnopq", text: null, sentAt: 2, state: "withdrawn", item: 1 },
      ],
    })
    const { container } = inApp(conversation)
    expect(container.textContent).toContain("went")
    expect(container.textContent).not.toContain("handed back")
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
      ["lost words", "unrecorded", "Sent, but not in the agent's record.send againeditterminal"],
      ["boxed words", "in-box", "It's back in Claude's box in the terminal.terminal"],
    ])
  })

  describe("a prompt the record never got", () => {
    const lost = (ref: string): Store<Conversation> =>
      createStore<Conversation>({
        ...asking,
        requests: [],
        prompts: [{ ref, text: "lost words", sentAt: 1, state: "unrecorded", item: null }],
      })
    const sentKey = (container: HTMLElement, name: string) =>
      [...container.querySelectorAll<HTMLElement>(".chat-sent button")].find(
        (each) => each.textContent === name,
      )

    it("goes again, and its line with it, as the receipt stays", async () => {
      const chat = inApp(lost("resendaaaaaaaaaa"))
      await act(async () => sentKey(chat.container, "send again")!.click())
      expect(chat.sent).toHaveBeenCalledWith("lost words")
      expect(
        [...chat.container.querySelectorAll(".chat-message[data-sent]")].filter(
          (each) => each.getAttribute("data-sent") === "unrecorded",
        ),
      ).toEqual([])
    })

    it("comes back to the box to edit, and its line goes", async () => {
      const chat = inApp(lost("editaaaaaaaaaaaa"))
      act(() => sentKey(chat.container, "edit")!.click())
      expect(box(chat.container).value).toBe("lost words")
      expect(document.activeElement).toBe(box(chat.container))
      expect(chat.container.querySelector(".chat-sent")).toBeNull()
    })

    it("says why it didn't go again, its words back in the box", async () => {
      const chat = inApp(lost("refusedaaaaaaaaa"), {
        send: async () => {
          throw new Error("The agent is waiting for your answer.")
        },
      })
      await act(async () => sentKey(chat.container, "send again")!.click())
      expect(chat.container.querySelector('[role="alert"]')?.textContent).toContain(
        "waiting for your answer",
      )
      expect(box(chat.container).value).toBe("lost words")
      expect(document.activeElement).toBe(box(chat.container))
    })

    it("still offers the terminal, where it may have gone after all", () => {
      const chat = inApp(lost("terminalaaaaaaaa"))
      expect(chat.container.querySelector('.chat-sent [aria-label="Show terminal"]')).not.toBeNull()
    })

    it("offers nothing that would turn it into a shell command", () => {
      const chat = inApp(lost("shellaaaaaaaaaaa"), { draft: "!git status" })
      expect(sentKey(chat.container, "send again")).toBeUndefined()
      expect(sentKey(chat.container, "edit")).toBeUndefined()
    })

    it("can't go again over words in the box, which it would take; edit joins them", () => {
      const chat = inApp(lost("draftaaaaaaaaaaa"), { draft: "and more" })
      expect(sentKey(chat.container, "send again")).toBeUndefined()
      act(() => sentKey(chat.container, "edit")!.click())
      expect(box(chat.container).value).toBe("lost words\nand more")
    })
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
    expect(chat.container.querySelector('button[aria-label="Send"]')).toBeNull()
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
      askedAt: 0,
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
    press(container, "cancel")
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

describe("a message sent over the agent's question", () => {
  const asked = (agent: "claude" | "codex" | "agy", chat: "prompt" | "field") =>
    createStore<Conversation>({
      ...questioning,
      agent,
      requests: questioning.requests.map((request) =>
        request.dialog?.type === "questions"
          ? { ...request, dialog: { ...request.dialog, chat } }
          : request,
      ),
    })

  it("sets the question aside, its card gone while the words go and after", async () => {
    const goes: ((result: SendResult) => void)[] = []
    const store = asked("claude", "prompt")
    const chat = inApp(store, {
      draft: "Do this instead",
      send: () => new Promise<SendResult>((resolve) => goes.push(resolve)),
    })
    const { container } = chat
    expect(container.querySelector(".chat-request")).not.toBeNull()
    await send(container)
    expect(chat.setAside).toEqual([["r1"]])
    expect(chat.draft()).toBe("")
    expect(container.querySelector(".chat-request")).toBeNull()
    expect(bubbles(container)).toEqual([["Do this instead", "sending", "sending"]])
    await act(async () => goes[0]!({ tracked: true }))
    expect(container.querySelector(".chat-request")).toBeNull()
    // The runner set it aside: the request goes, and the card stays gone.
    act(() => store.update((conversation) => ({ ...conversation, requests: [] })))
    expect(container.querySelector(".chat-request")).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it("puts the card back with the words and why, should the runner turn them away", async () => {
    const fails: ((failure: unknown) => void)[] = []
    const chat = inApp(asked("claude", "prompt"), {
      draft: "Do this instead",
      send: () => new Promise<SendResult>((_resolve, reject) => fails.push(reject)),
    })
    const { container } = chat
    await send(container)
    expect(container.querySelector(".chat-request")).toBeNull()
    await act(async () => fails[0]!(new Error("The agent isn't ready for a message yet.")))
    expect(container.querySelector(".chat-request")).not.toBeNull()
    expect(chat.draft()).toBe("Do this instead")
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("isn't ready")
    expect(bubbles(container)).toEqual([])
  })

  it("sets it aside from a plain message where the dialog's own field takes the words too", async () => {
    const chat = inApp(asked("agy", "field"), { draft: "Do this instead", program: "agy" })
    await send(chat.container)
    expect(chat.answered).not.toHaveBeenCalled()
    expect(chat.sent).toHaveBeenCalledWith("Do this instead")
    expect(chat.setAside).toEqual([["r1"]])
  })

  it("leaves a question that asks without waiting showing, never setting it aside", async () => {
    const store = asked("codex", "prompt")
    act(() =>
      store.update((conversation) => ({
        ...conversation,
        requests: conversation.requests.map((request) => ({ ...request, detached: true })),
      })),
    )
    const chat = inApp(store, {
      draft: "Go on",
      program: "codex",
      send: () => new Promise<void>(() => {}),
    })
    await send(chat.container)
    expect(chat.setAside).toEqual([undefined])
    expect(chat.container.querySelector(".chat-request")).not.toBeNull()
  })

  it("never sets a permission aside", async () => {
    const chat = inApp(createStore<Conversation>(asking), { draft: "Go on" })
    await send(chat.container)
    expect(chat.setAside).toEqual([undefined])
    expect(chat.container.querySelector(".chat-request")).not.toBeNull()
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
    expect(container.querySelector(".chat-composer .sr-only")?.textContent).toContain("Runs in")
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
    // The question comes after the message went: the message doesn't set it aside.
    const store = createStore<Conversation>(withDialog(null))
    const sends: (() => void)[] = []
    const chat = inApp(store, {
      draft: "first",
      program: "agy",
      send: () => new Promise<void>((resolve) => sends.push(resolve)),
    })
    const { container } = chat
    await send(container)
    act(() => store.update(() => withDialog("q1")))
    press(container, "Chat about this")
    // The reply's Cancel isn't locked by the message on its way.
    expect(button(container, "cancel").disabled).toBe(false)
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
      (each) => each.childElementCount === 0 && each.tagName === "DIV",
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
  const gap = (id: string, text: string): ChatItem => ({
    ...userItem(text),
    id,
    role: "note",
    note: { type: "gap" },
  })
  const view = (items: readonly ChatItem[]) =>
    inApp(
      createStore<Conversation>({
        ...noConversation,
        agent: "claude",
        session: "s",
        loaded: true,
        items,
      }),
    )

  it("marks where it stands among what could be read, the line there to open", () => {
    const { container } = view([
      { ...userItem("before"), id: "a" },
      gap("b", '{"type":"hologram"}'),
      { ...userItem("after"), id: "c" },
    ])
    const mark = container.querySelector('.chat-record[data-kind="gap"]')!
    const line = mark.querySelector<HTMLButtonElement>("button.chat-tool-summary")!
    expect(line.textContent).toBe("part of the record the chat can't read")
    // Closed until clicked, as a tool line is.
    expect(line.getAttribute("aria-expanded")).toBe("false")
    act(() => line.click())
    expect(mark.querySelector('[aria-label="As written"] pre')?.textContent).toBe(
      '{"type":"hologram"}',
    )
    const words = [...container.querySelectorAll(".chat-text")].map((each) => each.textContent)
    expect(words).toEqual(["before", "after"])
    const order = mark.compareDocumentPosition(container.querySelectorAll(".chat-text")[1]!)
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("marks the place alone where the line can't be shown", () => {
    const { container } = view([gap("b", "")])
    const mark = container.querySelector('.chat-record[data-kind="gap"]')!
    expect(mark.querySelector("button")).toBeNull()
    expect(mark.textContent).toBe("part of the record the chat can't read")
  })

  it("draws a compaction as a line that opens to the summary the agent goes on from", () => {
    const { container } = view([
      {
        ...userItem("Context so far: the logout comes from a minute of slack."),
        id: "k",
        role: "note",
        note: { type: "compaction" },
      },
    ])
    const mark = container.querySelector('.chat-record[data-kind="compaction"]')!
    const line = mark.querySelector<HTMLButtonElement>("button.chat-tool-summary")!
    expect(line.textContent).toBe("compacted the conversation · summary kept")
    act(() => line.click())
    expect(mark.querySelector('[aria-label="Summary"] pre')?.textContent).toBe(
      "Context so far: the logout comes from a minute of slack.",
    )
    expect(line.getAttribute("aria-expanded")).toBe("true")
  })

  it("draws a compaction with a sealed summary as a line that promises nothing", () => {
    const { container } = view([
      { ...userItem(""), id: "k", role: "note", note: { type: "compaction" } },
    ])
    const mark = container.querySelector('.chat-record[data-kind="compaction"]')!
    expect(mark.querySelector("button")).toBeNull()
    expect(mark.textContent).toBe("compacted the conversation")
  })

  it("says a summary was cut short", () => {
    const { container } = view([
      {
        ...userItem("A long summary"),
        id: "k",
        role: "note",
        truncated: true,
        note: { type: "compaction" },
      },
    ])
    act(() => container.querySelector<HTMLButtonElement>(".chat-record button")!.click())
    expect(container.querySelector(".chat-record .chat-tool-note")?.textContent).toContain(
      "Shortened here",
    )
  })
})

// Pastes into the box as the browser does: a clipboard with `files` and `text`.
const paste = (
  container: HTMLElement,
  { files = [], text = "" }: { readonly files?: readonly File[]; readonly text?: string },
): Event => {
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", {
    value: {
      files,
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  })
  act(() => void box(container).dispatchEvent(event))
  return event
}

const png = (name = "shot.png"): File =>
  new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" })

const chips = (container: HTMLElement): string[] =>
  [...container.querySelectorAll(".chat-attachment")].map(
    (each) =>
      `${each.querySelector("img, .chat-attachment-name")?.getAttribute("alt") ?? each.querySelector(".chat-attachment-name")?.textContent}:${(each as HTMLElement).dataset.state}`,
  )

// Lets the upload and the file read it follows settle.
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("a chat with images pasted into its box", () => {
  const live = { ...asking, requests: [] }

  it("uploads each at once, shows it as a chip, and sends the paths with the next message", async () => {
    const uploads: ((path: string) => void)[] = []
    const chat = inApp(createStore<Conversation>(live), {
      upload: () => new Promise<string>((resolve) => uploads.push(resolve)),
    })
    const { container } = chat
    const event = paste(container, { files: [png("a.png"), png("b.png")] })
    expect(event.defaultPrevented).toBe(true)
    await settle()
    // One at a time: the second goes up once the first is saved.
    expect(uploads).toHaveLength(1)
    expect(chips(container)).toEqual(["a.png:uploading", "b.png:uploading"])
    // Nothing is typed, and Send waits for the images rather than going without them.
    expect(sendButton(container).disabled).toBe(true)
    uploads[0]!("/runner/a.png")
    await settle()
    expect(uploads).toHaveLength(2)
    uploads[1]!("/runner/b.png")
    await settle()
    expect(chips(container)).toEqual(["a.png:ready", "b.png:ready"])
    expect(sendButton(container).disabled).toBe(false)
    await send(container)
    expect(chat.sent).toHaveBeenCalledWith("")
    expect(chat.sentImages).toEqual([["/runner/a.png", "/runner/b.png"]])
    expect(chips(container)).toEqual([])
    expect(chat.attachments()).toEqual([])
  })

  it("reads the clipboard for a paste that carries nothing, as Ctrl+Shift+V pastes an image alone", async () => {
    const read = vi.fn<() => Promise<unknown[]>>(async () => [
      {
        types: ["image/png"],
        getType: async () => new Blob([new Uint8Array([1])], { type: "image/png" }),
      },
    ])
    vi.stubGlobal("navigator", { ...navigator, clipboard: { read } })
    try {
      const chat = inApp(createStore<Conversation>(live), { upload: async () => "/runner/a.png" })
      const { container } = chat
      expect(paste(container, {}).defaultPrevented).toBe(true)
      await settle()
      expect(read).toHaveBeenCalledOnce()
      expect(chips(container)).toHaveLength(1)
      expect(chips(container)[0]).toMatch(/^pasted-.*\.png:ready$/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // A line with an image that the record never got: its receipt says so.
  const unrecordedWithImage = async (extra?: () => void) => {
    const conversation = createStore<Conversation>(live)
    const refs: string[] = []
    const chat = inApp(conversation, {
      upload: async () => "/runner/a.png",
      draft: "look",
      send: async () => ({ tracked: true }),
      onRef: (ref) => refs.push(ref),
    })
    paste(chat.container, { files: [png()] })
    await settle()
    await send(chat.container)
    extra?.()
    await act(async () =>
      conversation.update((now) => ({
        ...now,
        prompts: [{ ref: refs[0]!, text: "look", sentAt: 1, state: "unrecorded", item: null }],
      })),
    )
    return chat
  }

  it("sends a line the record never got again with its own images, not the box's", async () => {
    const chat = await unrecordedWithImage()
    expect(chat.container.querySelector(".chat-message[data-sent] .chat-images img")).not.toBeNull()
    const again = [...chat.container.querySelectorAll<HTMLElement>(".chat-sent button")].find(
      (each) => each.textContent === "send again",
    )!
    await act(async () => again.click())
    expect(chat.sentImages).toEqual([["/runner/a.png"], ["/runner/a.png"]])
  })

  it("takes the images of such a line back to the box to edit, and offers no resend with images there", async () => {
    const chat = await unrecordedWithImage()
    paste(chat.container, { files: [png("other.png")] })
    await settle()
    expect(
      [...chat.container.querySelectorAll(".chat-sent button")].map((each) => each.textContent),
    ).not.toContain("send again")
    const edit = [...chat.container.querySelectorAll<HTMLElement>(".chat-sent button")].find(
      (each) => each.textContent === "edit",
    )!
    act(() => edit.click())
    expect(chat.attachments().map(({ path }) => path)).toEqual(["/runner/a.png", "/runner/a.png"])
  })

  it("shows a line of images alone, which no receipt follows, until the record holds a turn", async () => {
    const conversation = createStore<Conversation>(live)
    const chat = inApp(conversation, { upload: async () => "/runner/a.png" })
    paste(chat.container, { files: [png()] })
    await settle()
    await send(chat.container)
    expect(
      chat.container.querySelectorAll(".chat-message[data-sent] .chat-images img"),
    ).toHaveLength(1)
    await act(async () => conversation.update((now) => ({ ...now, items: [userItem("")] })))
    expect(chat.container.querySelector(".chat-message[data-sent]")).toBeNull()
  })

  it("says why Enter did nothing while an image uploads", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: () => new Promise<string>(() => {}),
      draft: "look",
    })
    paste(chat.container, { files: [png()] })
    await settle()
    act(() => {
      box(chat.container).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      )
    })
    expect(chat.container.querySelector('[role="alert"]')?.textContent).toContain("still uploading")
    expect(chat.sent).not.toHaveBeenCalled()
  })

  it("takes only PNG, JPEG, GIF and WebP, and numbers images of one name", async () => {
    const chat = inApp(createStore<Conversation>(live), { upload: async () => "/runner/a.png" })
    const { container } = chat
    paste(container, { files: [new File([new Uint8Array(1)], "a.svg", { type: "image/svg+xml" })] })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "PNG, JPEG, GIF or WebP",
    )
    paste(container, { files: [png("same.png"), png("same.png")] })
    await settle()
    expect(chips(container)).toEqual(["same.png:ready", "same.png 2:ready"])
  })

  it("keeps the box to eight images as some come back, and says so", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/a.png",
      draft: "look",
      send: async () => {
        throw new Error("No agent here.")
      },
    })
    const { container } = chat
    paste(container, { files: Array.from({ length: 8 }, (_, i) => png(`${i}.png`)) })
    await settle()
    await send(container)
    // Eight came back; eight more were pasted meanwhile.
    expect(chat.attachments()).toHaveLength(8)
    paste(container, { files: Array.from({ length: 3 }, (_, i) => png(`n${i}.png`)) })
    await settle()
    expect(chat.attachments().length).toBeLessThanOrEqual(8)
  })

  it("asks Antigravity, which refuses images alone, for a few words with them", async () => {
    const chat = inApp(createStore<Conversation>({ ...live, agent: "agy" }), {
      upload: async () => "/runner/a.png",
    })
    const { container } = chat
    paste(container, { files: [png()] })
    await settle()
    expect(sendButton(container).disabled).toBe(true)
    expect(container.textContent).toContain("needs a few words with the images")
    set(box(container), "[Image #1] look")
    expect(sendButton(container).disabled).toBe(false)
    await send(container)
    expect(chat.sentImages).toEqual([["/runner/a.png"]])
    expect(chat.sentAt).toEqual([[0]])
  })

  it("asks for words too while the agent is not known yet", async () => {
    const chat = inApp(createStore<Conversation>({ ...live, agent: null }), {
      upload: async () => "/runner/a.png",
    })
    paste(chat.container, { files: [png()] })
    await settle()
    expect(sendButton(chat.container).disabled).toBe(true)
  })

  it("puts the images that came back out of the agent's box on a Stop in the box with the words", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/a.png",
      draft: "look",
      send: async () => ({ tracked: true }),
      interrupt: async () => ({ words: "boxed", images: ["/runner/a.png", "/runner/other.png"] }),
    })
    paste(chat.container, { files: [png()] })
    await settle()
    await send(chat.container)
    await chat.stop()
    // The images led the words they came with.
    expect(chat.draft()).toBe("[Image #1] [Image #2] boxed")
    expect(chat.attachments().map(({ path }) => path)).toEqual([
      "/runner/a.png",
      "/runner/other.png",
    ])
    // The one this window sent keeps its thumbnail; the other has none.
    expect(chips(chat.container)).toHaveLength(2)
  })

  it("takes the images of the agent's own box with its words, and no more than eight", async () => {
    const paths = Array.from({ length: 10 }, (_, i) => `/runner/${i}.png`)
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/x.png",
      takeBox: async () => ({ words: null, images: paths }),
    })
    await chat.take()
    expect(chat.attachments()).toHaveLength(8)
    expect(chat.container.textContent).toContain("8 images at most, so 2 went")
  })

  it("goes with the words, and leaves a text paste to the box", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/a.png",
      draft: "look",
    })
    const { container } = chat
    expect(paste(container, { text: "more words" }).defaultPrevented).toBe(false)
    expect(paste(container, { files: [png()], text: "cells" }).defaultPrevented).toBe(false)
    expect(chips(container)).toEqual([])
    paste(container, { files: [png()] })
    await settle()
    await send(container)
    // The caret was at the start: the image goes before the words.
    expect(chat.sent).toHaveBeenCalledWith("look")
    expect(chat.sentImages).toEqual([["/runner/a.png"]])
    expect(chat.sentAt).toEqual([[0]])
  })

  it("comes back to the box with the words when the send fails", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/a.png",
      draft: "look",
      send: async () => {
        throw new Error("No agent here.")
      },
    })
    const { container } = chat
    paste(container, { files: [png()] })
    await settle()
    await send(container)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("No agent here.")
    expect(chat.draft()).toBe("[Image #1] look")
    expect(chips(container)).toEqual(["shot.png:ready"])
    expect(chat.attachments().map(({ path }) => path)).toEqual(["/runner/a.png"])
  })

  it("shows the images in the sent line until the record has the turn", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/a.png",
      send: () => new Promise<void>(() => {}),
    })
    const { container } = chat
    paste(container, { files: [png()] })
    await settle()
    await send(container)
    expect(
      container.querySelector(".chat-message[data-sent] .chat-images img")?.getAttribute("alt"),
    ).toBe("shot.png")
  })

  it("keeps an image that failed, with why, and will not send until it is removed", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => {
        throw new Error("The runner is offline.")
      },
      draft: "look",
    })
    const { container } = chat
    paste(container, { files: [png()] })
    await settle()
    expect(chips(container)).toEqual(["shot.png:failed"])
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "The runner is offline.",
    )
    await send(container)
    expect(chat.sent).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Remove it to send the rest")
    press(container, "×")
    expect(chips(container)).toEqual([])
    await send(container)
    expect(chat.sent).toHaveBeenCalledWith("look")
  })

  it("refuses an image over what the backend takes, and more than eight", async () => {
    const chat = inApp(createStore<Conversation>(live), { upload: async () => "/runner/x.png" })
    const { container } = chat
    const big = new File([new Uint8Array(2048)], "big.png", { type: "image/png" })
    paste(container, { files: [big] })
    await settle()
    expect(chips(container)).toEqual(["big.png:failed"])
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("over 0 MiB")
    press(container, "×")
    paste(container, { files: Array.from({ length: 9 }, (_, i) => png(`${i}.png`)) })
    await settle()
    expect(chips(container)).toHaveLength(8)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "A message takes at most 8 images.",
    )
  })

  it("says where a backend takes no images", () => {
    const { container } = inApp(createStore<Conversation>(live))
    expect(paste(container, { files: [png()] }).defaultPrevented).toBe(true)
    expect(chips(container)).toEqual([])
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This backend can't take images.",
    )
  })

  it("refuses them in a reply to the agent's question, which takes one line of text", () => {
    const chat = inApp(createStore<Conversation>(questioning), {
      upload: async () => "/runner/a.png",
      program: "agy",
    })
    const { container } = chat
    press(container, "Chat about this")
    paste(container, { files: [png()] })
    expect(chips(container)).toEqual([])
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("takes text only")
  })

  // The box with its caret at `at`, as the person clicked there.
  const caretAt = (container: HTMLElement, at: number): void =>
    act(() => box(container).setSelectionRange(at, at))

  it("types a placeholder at the caret, labels the thumbnail with it, and sends the words with the image's place", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/a.png",
      draft: "see this: and fix it",
    })
    const { container } = chat
    caretAt(container, 10)
    paste(container, { files: [png()] })
    await settle()
    expect(chat.draft()).toBe("see this: [Image #1] and fix it")
    expect(box(container).selectionStart).toBe(21)
    expect(container.querySelector(".chat-attachment-n")?.textContent).toBe("#1")
    await send(container)
    expect(chat.sent).toHaveBeenCalledWith("see this:  and fix it")
    expect(chat.sentImages).toEqual([["/runner/a.png"]])
    expect(chat.sentAt).toEqual([[10]])
    // The line reads as it was written until the record has it.
    expect(bubbles(container)[0]![0]).toBe("see this: [Image #1] and fix it")
  })

  it("replaces a selection, numbers on from the highest in use, and starts again at 1 once none is left", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/a.png",
      draft: "one XX two",
    })
    const { container } = chat
    act(() => box(container).setSelectionRange(4, 6))
    paste(container, { files: [png("a.png")] })
    await settle()
    expect(chat.draft()).toBe("one [Image #1] two")
    caretAt(container, chat.draft().length)
    paste(container, { files: [png("b.png"), png("c.png")] })
    await settle()
    expect(chat.draft()).toBe("one [Image #1] two [Image #2] [Image #3] ")
    expect(
      [...container.querySelectorAll(".chat-attachment-n")].map((each) => each.textContent),
    ).toEqual(["#1", "#2", "#3"])
    // Deleting the middle one's words lets its image go, and the next takes the number after
    // the highest left.
    set(box(container), "one [Image #1] two [Image #3] ")
    expect(chips(container)).toEqual(["a.png:ready", "c.png:ready"])
    caretAt(container, 0)
    paste(container, { files: [png("d.png")] })
    await settle()
    expect(chat.draft().startsWith("[Image #4] one")).toBe(true)
    set(box(container), "no images now")
    expect(chips(container)).toEqual([])
    paste(container, { files: [png("e.png")] })
    await settle()
    expect(chat.draft()).toContain("[Image #1]")
  })

  it("lets the thumbnail's key take its placeholder out of the words", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/a.png",
      draft: "look at  now",
    })
    const { container } = chat
    caretAt(container, 8)
    paste(container, { files: [png("a.png")] })
    await settle()
    expect(chat.draft()).toBe("look at [Image #1] now")
    act(() => container.querySelector<HTMLElement>(".chat-attachment-remove")!.click())
    expect(chat.draft()).toBe("look at now")
    expect(chips(container)).toEqual([])
  })

  it("keeps a failed image's placeholder, which holds the message until it is removed", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => {
        throw new Error("No room.")
      },
      draft: "look",
    })
    const { container } = chat
    caretAt(container, 4)
    paste(container, { files: [png()] })
    await settle()
    expect(chat.draft()).toBe("look [Image #1] ")
    expect(chips(container)).toEqual(["shot.png:failed"])
    await send(container)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Remove it")
    expect(chat.sent).not.toHaveBeenCalled()
    expect(chat.draft()).toBe("look [Image #1] ")
  })

  it("inserts nothing for an image the box can't take", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/a.png",
      draft: "look",
    })
    const { container } = chat
    paste(container, { files: [new File([new Uint8Array(1)], "a.svg", { type: "image/svg+xml" })] })
    expect(chat.draft()).toBe("look")
    // A shell command takes text only.
    set(box(container), "!ls")
    paste(container, { files: [png()] })
    expect(chat.draft()).toBe("!ls")
    expect(chips(container)).toEqual([])
  })

  it("sends a message of placeholders alone as images with no words", async () => {
    const chat = inApp(createStore<Conversation>(live), { upload: async () => "/runner/a.png" })
    const { container } = chat
    paste(container, { files: [png("a.png"), png("b.png")] })
    await settle()
    expect(chat.draft()).toBe("[Image #1] [Image #2] ")
    await send(container)
    expect(chat.sent).toHaveBeenCalledWith("")
    expect(chat.sentAt).toEqual([[0, 0]])
  })

  it("puts the images a Stop gives back where they stood among the words", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/a.png",
      send: async () => ({ tracked: true }),
      interrupt: async () => ({
        words: "see this:  and fix it",
        images: ["/runner/z.png"],
        at: [10],
      }),
    })
    await chat.stop()
    expect(chat.draft()).toBe("see this: [Image #1] and fix it")
    expect(chat.attachments().map(({ path, n }) => [path, n])).toEqual([["/runner/z.png", 1]])
  })

  it("numbers the images that come back after those already in the box", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/a.png",
      takeBox: async () => ({
        words: "see this:  and fix it",
        images: ["/runner/z.png"],
        at: [10],
      }),
      draft: "mine",
    })
    caretAt(chat.container, 4)
    paste(chat.container, { files: [png()] })
    await settle()
    await chat.take()
    expect(chat.draft()).toBe("see this: [Image #2] and fix it\n\nmine [Image #1] ")
    expect(chat.attachments().map(({ n }) => n)).toEqual([2, 1])
  })

  it("lets a line's images come back to the box at their places, as it is edited", async () => {
    const chat = await unrecordedWithImage()
    const edit = [...chat.container.querySelectorAll<HTMLElement>(".chat-sent button")].find(
      (each) => each.textContent === "edit",
    )!
    act(() => edit.click())
    expect(chat.draft()).toContain("look")
    expect(chat.draft()).toContain("[Image #1]")
    expect(chat.attachments().map(({ n }) => n)).toEqual([1])
  })

  it("does not walk the history away from a box that holds an image", async () => {
    const chat = inApp(createStore<Conversation>(live), { upload: async () => "/runner/a.png" })
    const { container } = chat
    paste(container, { files: [png()] })
    await settle()
    caretAt(container, 0)
    const event = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })
    act(() => void box(container).dispatchEvent(event))
    expect(chat.draft()).toBe("[Image #1] ")
    expect(chips(container)).toHaveLength(1)
  })

  const pressKey = (container: HTMLElement, name: string): void =>
    act(() => {
      box(container).dispatchEvent(
        new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
      )
    })

  it("takes a placeholder whole on Backspace right after it, and on Delete before it", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/a.png",
      draft: "look",
    })
    const { container } = chat
    caretAt(container, 4)
    paste(container, { files: [png()] })
    await settle()
    expect(chat.draft()).toBe("look [Image #1] ")
    expect(box(container).selectionStart).toBe(16)
    // After the space it is the field's Backspace, which takes the space only.
    pressKey(container, "Backspace")
    expect(chat.draft()).toBe("look [Image #1] ")
    expect(chips(container)).toHaveLength(1)
    caretAt(container, 15)
    pressKey(container, "Backspace")
    expect(chat.draft()).toBe("look ")
    expect(chips(container)).toEqual([])
    caretAt(container, 4)
    paste(container, { files: [png()] })
    await settle()
    caretAt(container, 5)
    pressKey(container, "Delete")
    expect(chat.draft()).toBe("look ")
    expect(chips(container)).toEqual([])
    // Right after the mark itself, with words behind it.
    set(box(container), "look ")
    caretAt(container, 5)
    paste(container, { files: [png()] })
    await settle()
    set(box(container), "look [Image #1]x")
    expect(chips(container)).toHaveLength(1)
    caretAt(container, 15)
    pressKey(container, "Backspace")
    expect(chat.draft()).toBe("look x")
    expect(chips(container)).toEqual([])
  })

  it("takes the whole placeholder when an edit would leave a part of it", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/a.png",
      draft: "look",
    })
    const { container } = chat
    caretAt(container, 4)
    paste(container, { files: [png()] })
    await settle()
    // The closing bracket and the space went, as two Backspaces would do natively.
    set(box(container), "look [Image #1")
    expect(chat.draft()).toBe("look ")
    expect(chips(container)).toEqual([])
    caretAt(container, 5)
    paste(container, { files: [png()] })
    await settle()
    // Typing over a selection that covers the end of it and some words after.
    set(box(container), "look [Image #X")
    expect(chat.draft()).toBe("look X")
    expect(chips(container)).toEqual([])
  })

  it("judges the words without the placeholders, as the runner does", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/a.png",
      draft: "/review this",
      refuse: ["/review this"],
    })
    const { container } = chat
    caretAt(container, 0)
    paste(container, { files: [png()] })
    await settle()
    expect(chat.draft()).toBe("[Image #1] /review this")
    expect(sendButton(container).disabled).toBe(true)
    await send(container)
    expect(chat.sent).not.toHaveBeenCalled()
  })

  it("refuses a reply while the box holds images, and keeps both", async () => {
    const chat = inApp(createStore<Conversation>(questioning), {
      upload: async () => "/runner/a.png",
      draft: "look",
      program: "agy",
    })
    const { container } = chat
    caretAt(container, 4)
    paste(container, { files: [png()] })
    await settle()
    press(container, "Chat about this")
    expect(sendButton(container).disabled).toBe(true)
    expect(container.textContent).toContain("A reply can't take images")
    expect(container.textContent).not.toContain("The images wait")
    await send(container)
    expect(chat.draft()).toBe("look [Image #1] ")
    expect(chips(container)).toEqual(["shot.png:ready"])
  })

  it("refuses a shell command while the box holds images, and keeps both", async () => {
    const chat = inApp(createStore<Conversation>(live), { upload: async () => "/runner/a.png" })
    const { container } = chat
    paste(container, { files: [png()] })
    await settle()
    set(box(container), "!ls [Image #1]")
    expect(sendButton(container).disabled).toBe(true)
    expect(container.textContent).toContain("A shell command can't take images")
    await send(container)
    expect(chat.sent).not.toHaveBeenCalled()
    expect(chips(container)).toEqual(["shot.png:ready"])
  })

  it("refuses them in a shell command, which has no placeholder for one to stay by", async () => {
    const chat = inApp(createStore<Conversation>(live), {
      upload: async () => "/runner/a.png",
    })
    const { container } = chat
    paste(container, { files: [png()] })
    await settle()
    // The words that replace the placeholder take its image with them.
    set(box(container), "!ls")
    expect(chips(container)).toEqual([])
    paste(container, { files: [png("two.png")] })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "A shell command takes text only.",
    )
    await send(container)
    expect(chat.sent).toHaveBeenCalledWith("!ls")
    expect(chat.sentImages).toEqual([undefined])
    expect(chips(container)).toEqual([])
  })
})
