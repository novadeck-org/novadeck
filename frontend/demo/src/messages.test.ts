import { companionKeyId } from "@novadeck/core/items"
import { mailBadge } from "@novadeck/core/messages"
import { vi } from "vitest"

import { createDemoInbox } from "./inbox"
import { demoInboxIds, demoInboxItems } from "./inbox-fixtures"
import { checkoutMailboxes, createDemoMessages, rungMs } from "./messages"
import { demoTerminalId } from "./samples"
import { describe, expect, it } from "./test"

const storefront = { projectId: "storefront", workspaceSessionId: "initial" }
const elsewhere = { projectId: "api-service", workspaceSessionId: "initial" }
// A terminal of the session by its number, as `"01"`.
const at = (slot: string, target = storefront) =>
  companionKeyId({ ...target, terminalId: demoTerminalId(target, Number(slot)) })

const demo = () => createDemoMessages(checkoutMailboxes(1_000_000, [storefront, elsewhere]))

describe("the demo's messages", () => {
  it("show every state, a thread held for release, and an agent with none yet", () => {
    const { terminals } = demo().state.getSnapshot()
    const states = new Set(
      Object.values(terminals).flatMap((mail) =>
        mail.threads.flatMap((thread) => thread.messages.map((message) => message.state)),
      ),
    )
    expect([...states].toSorted()).toEqual(["delivered", "gone", "held", "leased", "queued"])
    expect(terminals[at("01")]?.threads.find((thread) => thread.peer === "owl")?.held).toBe(true)
    expect(terminals[at("01", elsewhere)]).toEqual({
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
      return mailBadge(terminals[at("04")], paused)
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
    vi.useRealTimers()
  })

  it("let a released thread go on, for both its terminals", () => {
    const messages = demo()
    messages.release("t-flaky")
    const { terminals } = messages.state.getSnapshot()
    for (const terminal of ["01", "03"]) {
      const thread = terminals[at(terminal)]?.threads.find((each) => each.id === "t-flaky")
      expect(thread).toMatchObject({ held: false, allowed: 25 })
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
      Object.values(messages.state.getSnapshot().terminals).flatMap((mail) =>
        mail.threads.flatMap((thread) => thread.messages),
      )
    expect(new Set(history().map((message) => message.inbox))).toEqual(new Set(["ask", "tell"]))
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
      from: "you",
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
  const samples = demoInboxItems(Date.now())
  const options = samples.find((item) => item.id === demoInboxIds.webhook)!
  const action = samples.find((item) => item.id === demoInboxIds.login)!
  messages.record(options)
  messages.record(action)
  const threads = Object.values(messages.state.getSnapshot().terminals).flatMap(
    (mail) => mail.threads,
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
      .flatMap((mail) => mail.threads.flatMap((thread) => thread.messages))
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
    const ask = demoInboxItems(Date.now()).find((item) => item.id === demoInboxIds.preview)!
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
  const history = Object.values(messages.state.getSnapshot().terminals).flatMap((mail) =>
    mail.threads.flatMap((thread) => thread.messages),
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
    const history = Object.values(messages.state.getSnapshot().terminals).flatMap((mail) =>
      mail.threads.flatMap((thread) => thread.messages),
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
  const history = Object.values(messages.state.getSnapshot().terminals).flatMap((mail) =>
    mail.threads.flatMap((thread) => thread.messages),
  )
  expect(history.find((message) => message.id === demoInboxIds.told)?.inboxState).toBe("read")
})

describe("the demo's sent messages", () => {
  const hop = (messages: ReturnType<typeof demo>, from: string, to: string) =>
    Object.values(messages.state.getSnapshot().terminals)
      .flatMap((mail) => mail.threads)
      .flatMap((thread) => thread.messages)
      .filter((message) => message.from === from && message.to === to)
      .map((message) => message.state)

  // Sends moth's message to crow, two agents of the first session.
  const sent = (messages: ReturnType<typeof demo>, text = "Hello", delivered?: () => void) =>
    messages.send(elsewhere, "moth", "crow", text, delivered)

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
    vi.useRealTimers()
  })

  it("delivers in the order sent", async () => {
    vi.useFakeTimers()
    const messages = demo()
    const order: string[] = []
    sent(messages, "one", () => order.push("one"))
    sent(messages, "two", () => order.push("two"))
    await vi.advanceTimersByTimeAsync(rungMs)
    expect(order).toEqual(["one", "two"])
    vi.useRealTimers()
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
    vi.useRealTimers()
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
    vi.useRealTimers()
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
    vi.useRealTimers()
  })

  it("holds a message past the hops its thread is allowed, until the person releases it", async () => {
    vi.useFakeTimers()
    const messages = demo()
    const delivered = vi.fn<() => void>()
    for (let index = 0; index < 12; index += 1) sent(messages, `Round ${index}`)
    await vi.advanceTimersByTimeAsync(rungMs)
    sent(messages, "One too many", delivered)
    await vi.advanceTimersByTimeAsync(rungMs * 3)
    expect(hop(messages, "moth", "crow").at(-1)).toBe("held")
    expect(delivered).not.toHaveBeenCalled()
    messages.release("t-crow-moth")
    expect(hop(messages, "moth", "crow").at(-1)).toBe("delivered")
    expect(delivered).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})
