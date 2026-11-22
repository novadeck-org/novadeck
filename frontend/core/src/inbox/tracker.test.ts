import { afterEach, beforeEach, vi } from "vitest"

import { emptyInbox, type InboxEntry } from "../inbox"
import { context, describe, expect, it } from "../test"
import type { TerminalMetadata } from "../types"
import {
  answerFailure,
  answerEntry,
  createInboxTracker,
  keepInbox,
  type InboxActions,
} from "./tracker"

const source = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "01",
  handle: "moth",
  agent: "claude",
  title: "Terminal 1",
  projectName: "App",
} as const

// Failed trouble derived from a limited end: no stored entry stands behind it.
const trouble: InboxEntry = {
  id: "limit:01:1",
  source,
  at: 1,
  stopped: true,
  seen: false,
  kind: "trouble",
  trouble: { type: "failed", error: "boom" },
}

const request: InboxEntry = {
  id: "request:r1",
  source,
  at: 1,
  stopped: true,
  seen: false,
  kind: "request",
  request: {
    id: "r1",
    kind: "permission",
    tool: "Bash",
    subject: "pnpm add x",
    choices: [],
    subagent: false,
    dialog: null,
    answered: false,
    askedAt: 0,
  },
}

const held: InboxEntry = {
  id: "held:th1",
  source,
  at: 1,
  stopped: false,
  seen: false,
  kind: "held",
  held: {
    threadId: "th1",
    from: { handle: "moth", title: "Terminal 1" },
    to: { handle: "fox", title: "Terminal 2" },
    text: "Ready?",
    hop: 3,
    heldFor: "loop",
  },
}

const reported: InboxEntry = {
  id: "update:01:100",
  source,
  at: 1,
  stopped: false,
  seen: false,
  kind: "update",
  update: { type: "done", subject: "Done", body: "ok" },
}

const settleMs = 1000

const setup = () => {
  const changed = vi.fn<() => void>()
  const tracker = createInboxTracker({ settleMs, changed })
  return { tracker, changed }
}

// An answer the test finishes when it likes.
const pending = () => {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const work = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { work: () => work, resolve, reject }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("The Inbox's answer tracker", () => {
  describe("what it shows", () => {
    it("marks the entries the person saw, until they go", () => {
      const { tracker, changed } = setup()
      tracker.see(trouble.id)
      tracker.see(trouble.id)

      expect(changed).toHaveBeenCalledTimes(1)
      expect(tracker.view([trouble]).items[0]).toMatchObject({ seen: true })
      tracker.view([])
      expect(tracker.view([trouble]).items[0]).toMatchObject({ seen: false })
    })

    it("shows a request already answered on its screen as answering", () => {
      const { tracker } = setup()
      const answered = { ...request, request: { ...request.request, answered: true } }

      expect(tracker.view([answered]).answering).toEqual({ [request.id]: true })
    })

    it("shows nothing on its way for an entry that is resolved, whatever it was before", () => {
      const { tracker } = setup()
      const resolved = {
        ...request,
        request: { ...request.request, answered: true },
        settled: { how: "answered" as const, at: 5 },
      }

      expect(tracker.view([resolved]).answering).toEqual({})
    })
  })

  describe("an answer", () => {
    it("shows answering from the call until its entry goes", async () => {
      const { tracker, changed } = setup()
      const answer = pending()
      tracker.call(trouble.id, answer.work)

      expect(changed).toHaveBeenCalledTimes(1)
      expect(tracker.view([trouble]).answering).toEqual({ [trouble.id]: true })
      answer.resolve()
      await flush()
      expect(tracker.view([trouble]).answering).toEqual({ [trouble.id]: true })
      expect(tracker.view([]).answering).toEqual({})
      expect(tracker.view([trouble]).answering).toEqual({})
    })

    it("fails with the reason, and gives the entry back to be answered again", async () => {
      const { tracker } = setup()
      const onError = vi.fn<() => void>()
      const answer = pending()
      tracker.call(trouble.id, answer.work, { onError })
      answer.reject(new Error("The agent is gone."))
      await flush()

      expect(onError).toHaveBeenCalledOnce()
      expect(tracker.view([trouble])).toMatchObject({
        answering: {},
        failed: { [trouble.id]: "The agent is gone." },
      })
      tracker.call(trouble.id, () => new Promise(() => {}))
      expect(tracker.view([trouble]).failed).toEqual({})
    })

    it("keeps a failure after its entry has gone, until the entry is answered again", async () => {
      const { tracker } = setup()
      tracker.fail(trouble.id, "No.")

      expect(tracker.view([]).failed).toEqual({ [trouble.id]: "No." })
      expect(tracker.view([trouble]).failed).toEqual({ [trouble.id]: "No." })
    })

    it("gives the buttons back after the settle time when it settles and the entry stands", async () => {
      const { tracker, changed } = setup()
      const answer = pending()
      tracker.call(trouble.id, answer.work, { settles: true })
      answer.resolve()
      await flush()
      expect(tracker.view([trouble]).answering).toEqual({ [trouble.id]: true })

      changed.mockClear()
      await vi.advanceTimersByTimeAsync(settleMs - 1)
      expect(changed).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      expect(changed).toHaveBeenCalledOnce()
      expect(tracker.view([trouble]).answering).toEqual({})
    })

    it("restarts the settle time when it is answered again", async () => {
      const { tracker, changed } = setup()
      tracker.call(trouble.id, () => Promise.resolve(), { settles: true })
      await vi.advanceTimersByTimeAsync(settleMs / 2)
      tracker.call(trouble.id, () => Promise.resolve(), { settles: true })
      await vi.advanceTimersByTimeAsync(settleMs / 2)
      changed.mockClear()
      await vi.advanceTimersByTimeAsync(settleMs / 2)

      expect(changed).toHaveBeenCalledOnce()
    })

    it("answered again while the first is on its way, speaks only for the latest", async () => {
      const { tracker } = setup()
      const first = pending()
      const second = pending()
      const onError = vi.fn<() => void>()
      tracker.call(trouble.id, first.work, { settles: true, onError })
      tracker.call(trouble.id, second.work, { settles: true })

      first.resolve()
      await vi.advanceTimersByTimeAsync(settleMs)
      expect(tracker.view([trouble]).answering).toEqual({ [trouble.id]: true })

      const third = pending()
      tracker.call(trouble.id, third.work)
      second.reject(new Error("Late."))
      await flush()
      expect(tracker.view([trouble])).toMatchObject({
        answering: { [trouble.id]: true },
        failed: {},
      })
      expect(onError).not.toHaveBeenCalled()

      third.reject(new Error("No."))
      await flush()
      expect(tracker.view([trouble])).toMatchObject({
        answering: {},
        failed: { [trouble.id]: "No." },
      })
    })

    it("says nothing once the tracker was reset, whatever it comes to", async () => {
      const { tracker } = setup()
      const answer = pending()
      tracker.call(trouble.id, answer.work, { settles: true })
      tracker.reset()
      answer.reject(new Error("Late."))
      await flush()

      expect(tracker.view([trouble])).toMatchObject({ answering: {}, failed: {} })
    })

    it("is kept by the backend's own track", async () => {
      const kept: Promise<unknown>[] = []
      const tracker = createInboxTracker({
        settleMs,
        changed: () => {},
        track: (work) => {
          kept.push(work)
          return work
        },
      })
      tracker.call(trouble.id, () => Promise.resolve())

      expect(kept).toHaveLength(1)
    })
  })

  describe("a failure", () => {
    it("takes the entry out of answering", () => {
      const { tracker, changed } = setup()
      tracker.submit([trouble.id])
      expect(tracker.view([trouble]).answering).toEqual({ [trouble.id]: true })
      tracker.fail(trouble.id, "No.")

      expect(changed).toHaveBeenCalledOnce()
      expect(tracker.view([trouble])).toMatchObject({
        answering: {},
        failed: { [trouble.id]: "No." },
      })
    })

    it("is kept for the next view with no change announced when it is noted", () => {
      const { tracker, changed } = setup()
      tracker.note(trouble.id, "Gone.")

      expect(changed).not.toHaveBeenCalled()
      expect(tracker.view([trouble]).failed).toEqual({ [trouble.id]: "Gone." })
    })

    it("is forgiven by the person trying again", () => {
      const { tracker } = setup()
      tracker.note(trouble.id, "Gone.")
      tracker.forgive(trouble.id)

      expect(tracker.view([trouble]).failed).toEqual({})
    })
  })

  describe("waking", () => {
    it("calls back when the earliest wait is up, skipping the ones already up", async () => {
      const { tracker, changed } = setup()
      tracker.wake([-5, 3000, 500, 0])
      await vi.advanceTimersByTimeAsync(499)
      expect(changed).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      expect(changed).toHaveBeenCalledOnce()
    })

    it("replaces the wait before it, and stops with no waits", async () => {
      const { tracker, changed } = setup()
      tracker.wake([500])
      tracker.wake([])
      await vi.advanceTimersByTimeAsync(10_000)

      expect(changed).not.toHaveBeenCalled()
    })

    it("stops its timers when the backend ends", async () => {
      const { tracker, changed } = setup()
      tracker.wake([500])
      tracker.call(trouble.id, () => Promise.resolve(), { settles: true })
      await flush()
      changed.mockClear()
      tracker.stop()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(changed).not.toHaveBeenCalled()
    })
  })

  describe("what a backend sends itself", () => {
    it("speaks to the Inbox until it is unbound or stopped", () => {
      const { tracker } = setup()
      const live = tracker.guard()
      expect(live()).toBe(true)
      tracker.reset()
      expect(live()).toBe(false)
      const next = tracker.guard()
      tracker.stop()
      expect(next()).toBe(false)
    })
  })

  describe("the state it keeps", () => {
    it("stays the same object while nothing in it changed", () => {
      const first = keepInbox(emptyInbox, { items: [trouble], answering: {}, failed: {} })
      const again = keepInbox(first, { items: [{ ...trouble }], answering: {}, failed: {} })

      expect(first).not.toBe(emptyInbox)
      expect(again).toBe(first)
      expect(keepInbox(first, { items: [trouble], answering: { x: true }, failed: {} })).not.toBe(
        first,
      )
    })
  })

  it("words a failure by its error, or says it didn't take", () => {
    expect(answerFailure(new Error("Out of room."))).toBe("Out of room.")
    expect(answerFailure(new Error(""))).toBe("That didn't take. Try again.")
    expect(answerFailure("no")).toBe("That didn't take. Try again.")
  })
})

describe("Answering an entry", () => {
  const actions = (terminal?: TerminalMetadata) =>
    ({
      request: vi.fn<InboxActions["request"]>(() => Promise.resolve()),
      release: vi.fn<InboxActions["release"]>(),
      stop: vi.fn<InboxActions["stop"]>(),
      read: vi.fn<InboxActions["read"]>(),
      forget: vi.fn<InboxActions["forget"]>(),
      send: vi.fn<InboxActions["send"]>(() => Promise.resolve()),
      interrupt: vi.fn<InboxActions["interrupt"]>(() => Promise.resolve()),
      terminal: vi.fn<InboxActions["terminal"]>(() => terminal),
    }) satisfies InboxActions
  const chosen = { type: "choice", dialog: "d1", option: "yes" } as const
  const key = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }
  const agent = (working: boolean): TerminalMetadata => ({
    id: "01",
    name: "Terminal 1",
    directory: "/work/app",
    command: "claude",
    process: "claude",
    handle: "moth",
    state: "running",
    agent: { working },
  })

  context("a request", () => {
    it("is answered through the agent's conversation, showing answering", async () => {
      const { tracker } = setup()
      const done = actions()
      answerEntry(tracker, request, { kind: "request", answer: chosen }, done)

      expect(done.request).toHaveBeenCalledWith(key, request, chosen)
      expect(tracker.view([request]).answering).toEqual({ [request.id]: true })
    })
  })

  context("a held message", () => {
    it("is released or stopped by its thread", () => {
      const { tracker } = setup()
      const done = actions()
      answerEntry(tracker, held, { kind: "held", action: "release" }, done)
      answerEntry(tracker, held, { kind: "held", action: "stop" }, done)

      expect(done.release).toHaveBeenCalledWith("th1")
      expect(done.stop).toHaveBeenCalledWith("th1")
    })

    it("forgets its earlier failure", () => {
      const { tracker } = setup()
      tracker.note(held.id, "No.")
      answerEntry(tracker, held, { kind: "held", action: "release" }, actions())

      expect(tracker.view([held]).failed).toEqual({})
    })
  })

  context("a done report", () => {
    it("is read by its id", () => {
      const { tracker } = setup()
      const done = actions()
      answerEntry(tracker, reported, { kind: "update", action: "read" }, done)

      expect(done.read).toHaveBeenCalledWith([reported.id])
    })
  })

  context("trouble", () => {
    it("continues by sending continue, and stops by interrupting", async () => {
      const { tracker } = setup()
      const done = actions()
      answerEntry(tracker, trouble, { kind: "trouble", action: { type: "continue" } }, done)
      await flush()
      answerEntry(tracker, trouble, { kind: "trouble", action: { type: "stop" } }, done)

      expect(done.send).toHaveBeenCalledWith(key, "continue", { automatic: true })
      expect(done.interrupt).toHaveBeenCalledWith(key)
    })

    it("nudges a working agent after interrupting it", async () => {
      const { tracker } = setup()
      const done = actions(agent(true))
      answerEntry(
        tracker,
        trouble,
        { kind: "trouble", action: { type: "nudge", text: "go" } },
        done,
      )
      await flush()

      expect(done.interrupt).toHaveBeenCalledWith(key)
      expect(done.send).toHaveBeenCalledWith(key, "go", { automatic: true })
      expect(done.interrupt.mock.invocationCallOrder[0]).toBeLessThan(
        done.send.mock.invocationCallOrder[0]!,
      )
    })

    it("nudges an agent at rest without interrupting it", async () => {
      const { tracker } = setup()
      const done = actions(agent(false))
      answerEntry(
        tracker,
        trouble,
        { kind: "trouble", action: { type: "nudge", text: "go" } },
        done,
      )
      await flush()

      expect(done.interrupt).not.toHaveBeenCalled()
      expect(done.send).toHaveBeenCalledWith(key, "go", { automatic: true })
    })

    it("sends the person's own nudge as theirs, not automatic", async () => {
      const { tracker } = setup()
      const done = actions(agent(false))
      answerEntry(
        tracker,
        trouble,
        { kind: "trouble", action: { type: "nudge", text: "try the cache", own: true } },
        done,
      )
      await flush()

      expect(done.send).toHaveBeenCalledWith(key, "try the cache", undefined)
    })

    describe("a stored failed turn", () => {
      const entry = (stopped: boolean): InboxEntry => ({
        ...trouble,
        id: "row-1",
        stopped,
        trouble: { type: "failed", error: "boom", stored: true },
      })
      const nudge = { kind: "trouble", action: { type: "nudge", text: "fix" } } as const

      it("is nudged while it is current and the agent rests, then read without waiting", async () => {
        const { tracker } = setup()
        const done = actions(agent(false))
        answerEntry(tracker, entry(true), nudge, done)
        await flush()

        expect(done.send).toHaveBeenCalledWith(key, "fix", { automatic: true })
        expect(done.forget).toHaveBeenCalledWith(["row-1"])
        expect(done.read).not.toHaveBeenCalled()
      })

      it("offers no nudge while the agent works, and interrupts nothing", async () => {
        const { tracker } = setup()
        const done = actions(agent(true))
        answerEntry(tracker, entry(true), nudge, done)
        await flush()

        expect(done.interrupt).not.toHaveBeenCalled()
        expect(done.send).not.toHaveBeenCalled()
        expect(tracker.view([entry(true)]).failed).toHaveProperty("row-1")
      })

      it("offers no nudge once it is no longer current", async () => {
        const { tracker } = setup()
        const done = actions(agent(false))
        answerEntry(tracker, entry(false), nudge, done)
        await flush()

        expect(done.send).not.toHaveBeenCalled()
        expect(done.forget).not.toHaveBeenCalled()
      })
    })

    it("gives the buttons back after the settle time if the entry stands", async () => {
      const { tracker } = setup()
      answerEntry(tracker, trouble, { kind: "trouble", action: { type: "stop" } }, actions())
      await vi.advanceTimersByTimeAsync(settleMs)

      expect(tracker.view([trouble]).answering).toEqual({})
    })

    it("leaves auto-resume to the backend", () => {
      const { tracker, changed } = setup()
      const done = actions()
      answerEntry(
        tracker,
        trouble,
        { kind: "trouble", action: { type: "auto-resume", on: true } },
        done,
      )

      expect(changed).not.toHaveBeenCalled()
    })
  })

  it("fails an answer meant for another kind of entry", () => {
    const { tracker } = setup()
    const done = actions()
    answerEntry(tracker, trouble, { kind: "update", action: "read" }, done)

    expect(done.read).not.toHaveBeenCalled()
    expect(tracker.view([trouble]).failed).toEqual({
      [trouble.id]: "That answer isn't for this item.",
    })
  })
})
