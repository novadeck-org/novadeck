import { messageBadge, type MessageParty } from "@novadeck/core/messages"
import { terminalKeyPath } from "@novadeck/core/types"
import { afterEach, vi } from "vitest"

import { createDemoInbox } from "./inbox"
import { demoInboxIds, demoInboxRows } from "./inbox/fixtures"
import { checkoutMessages, createDemoMessages, partyOf, rungMs } from "./messages"
import { demoTerminalId } from "./samples"
import { describe, expect, it } from "./test"

const storefront = { projectId: "storefront", workspaceSessionId: "initial" }
const elsewhere = { projectId: "api-service", workspaceSessionId: "initial" }
// A terminal of the session by its number, as `"01"`.
const at = (slot: string, target = storefront) =>
  terminalKeyPath({ ...target, terminalId: demoTerminalId(target, Number(slot)) })

const demo = () => createDemoMessages(checkoutMessages(1_000_000, [storefront, elsewhere]))

// Whether a message party is the agent at a handle.
const partyIs = (party: MessageParty, handle: string): boolean =>
  party.kind === "agent" && party.handle === handle

describe("the demo's messages", () => {
  // Six idle messages in a row between moth and crow of the second session: a loop, held.
  const looped = () => {
    const messages = demo()
    for (let index = 0; index < 6; index += 1)
      messages.send(elsewhere, "moth", "crow", "Thanks", undefined, undefined, true)
    return messages
  }

  it("show every state, a thread held for release, and an agent with none yet", () => {
    const { terminals } = looped().state.getSnapshot()
    const states = new Set(
      Object.values(terminals).flatMap((terminalMessages) =>
        terminalMessages.threads.flatMap((thread) =>
          thread.messages.map((message) => message.state),
        ),
      ),
    )
    expect([...states].toSorted()).toEqual(["delivered", "gone", "held", "leased", "queued"])
    expect(
      terminals[at("01", elsewhere)]?.threads.find((thread) => partyIs(thread.peer, "crow"))?.held,
    ).toBe(true)
    expect(demo().state.getSnapshot().terminals[at("01", elsewhere)]).toEqual({
      handle: "moth",
      agent: true,
      waits: null,
      threads: [],
    })
  })

  it("hold what waits once a pause arrives, and let it wait again once resumed", () => {
    vi.useFakeTimers()
    const messages = demo()
    const badge = () => {
      const { terminals, paused } = messages.state.getSnapshot()
      return messageBadge(terminals[at("04")], paused)
    }
    expect(badge()).toEqual({ count: 2, kind: "waiting" })
    messages.pause(true)
    // On its way, as to a runner.
    expect(messages.state.getSnapshot().pending).toBe(true)
    vi.runAllTimers()
    expect(messages.state.getSnapshot().pending).toBe(false)
    expect(badge()).toEqual({ count: 2, kind: "paused" })
    messages.pause(false)
    vi.runAllTimers()
    expect(badge()).toEqual({ count: 2, kind: "waiting" })
  })

  it("let a released thread go on, for both its terminals", () => {
    const messages = looped()
    messages.release("t-crow-moth")
    const { terminals } = messages.state.getSnapshot()
    for (const terminal of ["01", "04"]) {
      const thread = terminals[at(terminal, elsewhere)]?.threads.find(
        (each) => each.id === "t-crow-moth",
      )
      expect(thread).toMatchObject({ held: false, heldFor: null, idle: 0 })
      expect(thread?.messages.at(-1)?.state).toBe("queued")
    }
  })
})

it("records asks, tells and accepted person replies in the demo's You threads", () => {
  vi.useFakeTimers()
  try {
    const messages = createDemoMessages([])
    const inbox = createDemoInbox(Date.now(), undefined, messages.record)
    const history = () =>
      Object.values(messages.state.getSnapshot().terminals).flatMap((terminalMessages) =>
        terminalMessages.threads.flatMap((thread) => thread.messages),
      )
    expect(new Set(history().map((message) => message.inbox))).toEqual(
      new Set(["ask", "tell", "done"]),
    )
    inbox.failNext()
    inbox.answer(demoInboxIds.preview, {
      kind: "ask",
      answer: { type: "reply", option: null, text: "Samples" },
    })
    expect(history().filter((message) => message.inbox === "answer")).toEqual([])
    inbox.answer(demoInboxIds.preview, {
      kind: "ask",
      answer: { type: "reply", option: null, text: "Samples" },
    })
    vi.advanceTimersByTime(600)
    expect(history().find((message) => message.inbox === "answer")).toMatchObject({
      from: { kind: "person" },
      text: "Samples",
      state: "queued",
    })
    vi.advanceTimersByTime(2000)
    expect(history().find((message) => message.inbox === "answer")?.state).toBe("delivered")
  } finally {
    vi.useRealTimers()
  }
})

it("keeps options, recommendations, code and action labels in separate Inbox history threads", () => {
  const messages = createDemoMessages([])
  const samples = demoInboxRows(Date.now())
  const options = samples.find((item) => item.id === demoInboxIds.webhook)!
  const action = samples.find((item) => item.id === demoInboxIds.login)!
  messages.record(options)
  messages.record(action)
  const threads = Object.values(messages.state.getSnapshot().terminals).flatMap(
    (terminalMessages) => terminalMessages.threads,
  )
  expect(threads).toHaveLength(2)
  const decision = threads.find((thread) => thread.id === `t-${options.id.replaceAll("-", "")}`)!
  expect(decision.messages[0]?.text).toContain("(recommended)")
  expect(decision.messages[0]?.text).toContain("Hard to undo:")
  expect(decision.messages[0]?.text).toContain("migrations/0032_webhook_errors.sql")
  expect(decision.messages[0]?.text).toContain("ALTER TABLE")
  vi.useFakeTimers()
  try {
    messages.record(action, { kind: "ask", answer: { type: "done" } })
    const reply = Object.values(messages.state.getSnapshot().terminals)
      .flatMap((terminalMessages) => terminalMessages.threads.flatMap((thread) => thread.messages))
      .find((message) => message.inbox === "answer")
    expect(reply?.text).toBe("I've logged in")
    vi.runAllTimers()
  } finally {
    vi.useRealTimers()
  }
})

it("delivers the person's reply while messages between agents are paused", () => {
  vi.useFakeTimers()
  try {
    const messages = createDemoMessages([], true)
    const ask = demoInboxRows(Date.now()).find((item) => item.id === demoInboxIds.preview)!
    messages.record(ask)
    messages.record(ask, { kind: "ask", answer: { type: "reply", option: null, text: "Samples" } })
    const thread = () => Object.values(messages.state.getSnapshot().terminals)[0]!.threads[0]!
    expect(thread().held).toBe(false)
    expect(thread().messages.at(-1)).toMatchObject({ state: "queued", held: null })
    vi.runAllTimers()
    expect(thread().messages.at(-1)?.state).toBe("delivered")
    expect(messages.state.getSnapshot().paused).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

it("records an ask's withdrawal and ended session without losing its text", () => {
  const messages = createDemoMessages([])
  const inbox = createDemoInbox(Date.now(), undefined, messages.record)
  inbox.resolve(demoInboxIds.preview, "withdrawn")
  inbox.resolve(demoInboxIds.login, "gone")
  const history = Object.values(messages.state.getSnapshot().terminals).flatMap(
    (terminalMessages) => terminalMessages.threads.flatMap((thread) => thread.messages),
  )
  expect(history.find((message) => message.id === demoInboxIds.preview)).toMatchObject({
    inboxState: "withdrawn",
    text: expect.stringContaining("Should the preview"),
  })
  expect(history.find((message) => message.id === demoInboxIds.login)).toMatchObject({
    inboxState: "gone",
    text: expect.stringContaining("vercel login"),
  })
})

it("keeps an undelivered reply and its ask's outcome in history", () => {
  vi.useFakeTimers()
  try {
    const messages = createDemoMessages([])
    const inbox = createDemoInbox(Date.now(), undefined, messages.record)
    inbox.dropReplyNext()
    inbox.answer(demoInboxIds.preview, {
      kind: "ask",
      answer: { type: "reply", option: null, text: "Samples" },
    })
    vi.runAllTimers()
    const history = Object.values(messages.state.getSnapshot().terminals).flatMap(
      (terminalMessages) => terminalMessages.threads.flatMap((thread) => thread.messages),
    )
    expect(history.find((message) => message.id === demoInboxIds.preview)?.inboxState).toBe(
      "undelivered",
    )
    expect(history.find((message) => message.inbox === "answer")).toMatchObject({
      state: "gone",
      deliveredAt: null,
    })
    expect(inbox.state.getSnapshot().failed[demoInboxIds.preview]).toContain(
      "Your reply was not delivered",
    )
  } finally {
    vi.useRealTimers()
  }
})

it("marks told history read when updates are read together", () => {
  const messages = createDemoMessages([])
  const inbox = createDemoInbox(Date.now(), undefined, messages.record)
  inbox.readAll()
  const history = Object.values(messages.state.getSnapshot().terminals).flatMap(
    (terminalMessages) => terminalMessages.threads.flatMap((thread) => thread.messages),
  )
  expect(history.find((message) => message.id === demoInboxIds.told)?.inboxState).toBe("read")
})

describe("the demo's sent messages", () => {
  afterEach(() => {})

  const hop = (messages: ReturnType<typeof demo>, from: string, to: string) =>
    Object.values(messages.state.getSnapshot().terminals)
      .flatMap((terminalMessages) => terminalMessages.threads)
      .flatMap((thread) => thread.messages)
      .filter((message) => partyIs(message.from, from) && partyIs(message.to, to))
      .map((message) => message.state)

  // Sends moth's message to crow, two agents of the first session.
  const sent = (
    messages: ReturnType<typeof demo>,
    text = "Hello",
    delivered?: () => void,
    idle = false,
  ) => messages.send(elsewhere, "moth", "crow", text, delivered, undefined, idle)

  it("queues a message, then delivers it once the doorbell rang, and calls back", async () => {
    vi.useFakeTimers()
    const messages = demo()
    const delivered = vi.fn<() => void>()
    sent(messages, "Hello", delivered)
    expect(hop(messages, "moth", "crow").at(-1)).toBe("queued")
    expect(delivered).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(rungMs)
    expect(hop(messages, "moth", "crow").at(-1)).toBe("delivered")
    expect(delivered).toHaveBeenCalledOnce()
  })

  it("delivers in the order sent", async () => {
    vi.useFakeTimers()
    const messages = demo()
    const order: string[] = []
    sent(messages, "one", () => order.push("one"))
    sent(messages, "two", () => order.push("two"))
    await vi.advanceTimersByTimeAsync(rungMs)
    expect(order).toEqual(["one", "two"])
  })

  it("holds a message while paused, and delivers it once resumed", async () => {
    vi.useFakeTimers()
    const messages = demo()
    messages.pause(true)
    await vi.advanceTimersByTimeAsync(200)
    const delivered = vi.fn<() => void>()
    sent(messages, "Hello", delivered)
    await vi.advanceTimersByTimeAsync(rungMs * 3)
    expect(hop(messages, "moth", "crow").at(-1)).toBe("held")
    expect(delivered).not.toHaveBeenCalled()
    messages.pause(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(hop(messages, "moth", "crow").at(-1)).toBe("delivered")
    expect(delivered).toHaveBeenCalledOnce()
  })

  it("waits for a recipient the doorbell can't ring, and delivers once it can", async () => {
    vi.useFakeTimers()
    const messages = demo()
    const crow = { ...elsewhere, terminalId: demoTerminalId(elsewhere, 4) }
    messages.waits!(crow, "working")
    const delivered = vi.fn<() => void>()
    sent(messages, "Hello", delivered)
    await vi.advanceTimersByTimeAsync(rungMs * 3)
    expect(hop(messages, "moth", "crow").at(-1)).toBe("queued")
    expect(delivered).not.toHaveBeenCalled()
    messages.waits!(crow, null)
    expect(hop(messages, "moth", "crow").at(-1)).toBe("delivered")
    expect(delivered).toHaveBeenCalledOnce()
  })

  it("never delivers a message its thread's stop dropped", async () => {
    vi.useFakeTimers()
    const messages = demo()
    const delivered = vi.fn<() => void>()
    sent(messages, "Hello", delivered)
    messages.stop("t-crow-moth")
    await vi.advanceTimersByTimeAsync(rungMs * 3)
    expect(hop(messages, "moth", "crow").at(-1)).toBe("gone")
    expect(delivered).not.toHaveBeenCalled()
  })

  const crowThread = (messages: ReturnType<typeof demo>) =>
    Object.values(messages.state.getSnapshot().terminals)
      .flatMap((terminalMessages) => terminalMessages.threads)
      .find((each) => each.id === "t-crow-moth")!

  it("holds the sixth idle message in a row, as a loop, until the person releases it", async () => {
    vi.useFakeTimers()
    const messages = demo()
    const delivered = vi.fn<() => void>()
    for (let index = 0; index < 5; index += 1) sent(messages, `Thanks ${index}`, undefined, true)
    await vi.advanceTimersByTimeAsync(rungMs)
    expect(crowThread(messages)).toMatchObject({ idle: 5, held: false, heldFor: null })
    sent(messages, "Thanks again", delivered, true)
    await vi.advanceTimersByTimeAsync(rungMs * 3)
    expect(crowThread(messages)).toMatchObject({ idle: 6, held: true, heldFor: "loop" })
    expect(hop(messages, "moth", "crow").at(-1)).toBe("held")
    expect(delivered).not.toHaveBeenCalled()
    messages.release("t-crow-moth")
    expect(crowThread(messages)).toMatchObject({ idle: 0, held: false, heldFor: null })
    expect(hop(messages, "moth", "crow").at(-1)).toBe("delivered")
    expect(delivered).toHaveBeenCalledOnce()
  })

  it("holds for idle messages only, never for a thread's length", async () => {
    vi.useFakeTimers()
    const messages = demo()
    for (let index = 0; index < 20; index += 1) sent(messages, `Round ${index}`)
    // A message that isn't idle sets the count back to none.
    for (let index = 0; index < 5; index += 1) sent(messages, "Noted", undefined, true)
    sent(messages, "Back at work")
    for (let index = 0; index < 5; index += 1) sent(messages, "Noted", undefined, true)
    await vi.advanceTimersByTimeAsync(rungMs)
    expect(crowThread(messages)).toMatchObject({ idle: 5, held: false })
    expect(hop(messages, "moth", "crow").at(-1)).toBe("delivered")
  })

  it("refuses a send beyond the ten a pair keeps waiting held for release", () => {
    vi.useFakeTimers()
    const messages = demo()
    // Five idle messages go through, the sixth starts the hold, and ten in all wait held.
    for (let index = 0; index < 5; index += 1)
      expect(sent(messages, "Noted", undefined, true)).toBe(true)
    for (let index = 0; index < 10; index += 1)
      expect(sent(messages, "Noted", undefined, true)).toBe(true)
    expect(sent(messages, "Noted", undefined, true)).toBe(false)
    expect(sent(messages, "Working")).toBe(false)
    const waiting = crowThread(messages).messages.filter((message) => message.held === "release")
    expect(waiting).toHaveLength(10)
  })

  it("joins a seeded thread between the pair, and goes on from its own hops", async () => {
    vi.useFakeTimers()
    const messages = demo()
    // The first session's moth and crow already have `t-review`, four messages in.
    messages.send(storefront, "crow", "moth", "Thanks, looks right now.")
    const thread = () =>
      Object.values(messages.state.getSnapshot().terminals)
        .flatMap((terminalMessages) => terminalMessages.threads)
        .find((each) => each.id === "t-review")!
    expect(thread().messages.at(-1)).toMatchObject({ hop: 5, state: "queued" })
    expect(thread().hops).toBe(5)
    // No second thread opened between the pair.
    const ids = Object.values(messages.state.getSnapshot().terminals)
      .flatMap((terminalMessages) => terminalMessages.threads)
      .map((each) => each.id)
    expect(ids).not.toContain("t-crow-moth")
    await vi.advanceTimersByTimeAsync(rungMs)
    expect(thread().messages.at(-1)).toMatchObject({ state: "delivered" })
  })

  it("tells the sender, by its callback, when a stop drops its message, and refuses later sends", async () => {
    const messages = demo()
    const stopped = vi.fn<() => void>()
    const delivered = vi.fn<() => void>()
    expect(messages.send(elsewhere, "moth", "crow", "Hello", delivered, stopped)).toBe(true)
    messages.stop("t-crow-moth")
    expect(stopped).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(rungMs * 3)
    expect(delivered).not.toHaveBeenCalled()
    const all = () =>
      Object.values(messages.state.getSnapshot().terminals)
        .flatMap((terminalMessages) => terminalMessages.threads)
        .filter((thread) => thread.id === "t-crow-moth")
        .flatMap((thread) => thread.messages)
    // The runner adds nothing to the thread: the message is gone, and none is the person's.
    expect(all().map((message) => message.state)).toEqual(["gone", "gone"])
    expect(all().some((message) => message.from.kind === "person")).toBe(false)
    // Either end's later send on the stopped thread is refused, and queues nothing.
    expect(messages.send(elsewhere, "crow", "moth", "Hello again")).toBe(false)
    expect(all()).toHaveLength(2)
  })
})

describe("the demo's loop hold, as the runner keeps it", () => {
  const target = { projectId: "p", workspaceSessionId: "s" }
  const idleMessage = (id: string, hop: number, state: "delivered" | "queued") => ({
    id,
    hop,
    idle: true as const,
    from: partyOf("moth"),
    to: partyOf("crow"),
    text: "Noted",
    sentAt: 1000 + hop,
    state,
    deliveredAt: state === "delivered" ? 1000 + hop : null,
  })
  const terminals = [
    { terminalId: "a", handle: "moth", agent: true },
    { terminalId: "b", handle: "crow", agent: true },
  ]
  const threadOf = (messages: ReturnType<typeof demo>, id: string) =>
    Object.values(messages.state.getSnapshot().terminals)
      .flatMap((terminalMessages) => terminalMessages.threads)
      .find((each) => each.id === id)!

  it("ends the hold at a stop, as a release does, so the next messages count afresh", async () => {
    vi.useFakeTimers()
    const messages = demo()
    for (let index = 0; index < 6; index += 1)
      messages.send(elsewhere, "moth", "crow", "Thanks", undefined, undefined, true)
    expect(threadOf(messages, "t-crow-moth")).toMatchObject({ held: true, idle: 6 })
    messages.stop("t-crow-moth")
    expect(threadOf(messages, "t-crow-moth")).toMatchObject({ held: false, heldFor: null, idle: 0 })
    // Once the stop's refusal lapses, the pair's next idle message is the first of a new count.
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(messages.send(elsewhere, "moth", "crow", "Hello", undefined, undefined, true)).toBe(true)
    expect(threadOf(messages, "t-crow-moth")).toMatchObject({ held: false, idle: 1 })
  })

  it("has a hold from the sixth idle message even when no message waits held", () => {
    const delivered = Array.from({ length: 6 }, (_, index) =>
      idleMessage(`a-${index + 1}`, index + 1, "delivered"),
    )
    const messages = createDemoMessages([
      {
        target,
        terminals,
        threads: [{ id: "a", between: ["moth", "crow"], hops: 6, messages: delivered }],
      },
    ])
    expect(threadOf(messages, "a")).toMatchObject({ held: true, heldFor: "loop", idle: 6 })
    expect(threadOf(messages, "a").messages.every((each) => each.held === null)).toBe(true)
  })

  it("starts the hold at a refused send's would-be hop, without using the hop", () => {
    const earlier = Array.from({ length: 5 }, (_, index) =>
      idleMessage(`b-${index + 1}`, index + 1, "delivered"),
    )
    const waiting = Array.from({ length: 15 }, (_, index) =>
      idleMessage(`a-${index + 1}`, index + 1, index < 5 ? "delivered" : "queued"),
    )
    const messages = createDemoMessages([
      {
        target,
        terminals,
        threads: [
          { id: "b", between: ["moth", "crow"], hops: 5, messages: earlier },
          { id: "a", between: ["moth", "crow"], hops: 15, messages: waiting },
        ],
      },
    ])
    // Ten wait held in the pair's other thread, so the sixth idle message here is refused.
    expect(messages.send(target, "moth", "crow", "Noted", undefined, undefined, true)).toBe(false)
    expect(threadOf(messages, "b")).toMatchObject({ held: true, heldFor: "loop", hops: 5 })
    expect(threadOf(messages, "b").messages).toHaveLength(5)
  })
})
