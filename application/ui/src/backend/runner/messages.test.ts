import type { TerminalMessages } from "@novadeck/protocol"
import { vi } from "vitest"

import { companionKeyId } from "../../model/companion"
import { context, describe, expect, it } from "../../test"
import { createRunnerMessages, type MailStreams } from "./messages"

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "a" }
const id = companionKeyId(key)

// A terminal's listing as the runner streams it: Codex in t2 sent t1 a message.
const listing = (change: Partial<TerminalMessages> = {}): TerminalMessages => ({
  terminalId: "a",
  handle: "t1",
  delivery: "working",
  paused: false,
  threads: [
    {
      id: "t-1",
      peer: "t2",
      hops: 1,
      allowed: 12,
      held: false,
      messages: [
        {
          id: "m-1",
          thread: "t-1",
          hop: 1,
          from: "t2",
          fromAgent: "codex",
          to: "t1",
          toAgent: "claude",
          text: "Review a.ts.",
          sentAt: 1,
          state: "queued",
          held: null,
          deliveredAt: null,
        },
      ],
    },
  ],
  ...change,
})

// Listings the test pushes, read by the adapter as `messages.watch` would stream them.
const streamed = () => {
  const queued: (TerminalMessages | "end")[] = []
  let wake: (() => void) | undefined
  const watch = vi.fn<MailStreams["watch"]>(() => {
    const iterator: AsyncIterableIterator<TerminalMessages, undefined> = {
      [Symbol.asyncIterator]: () => iterator,
      next: async () => {
        // eslint-disable-next-line no-await-in-loop -- Waits for the next pushed listing.
        while (!queued.length) await new Promise<void>((resolve) => (wake = resolve))
        const next = queued.shift()!
        return next === "end" ? { value: undefined, done: true } : { value: next, done: false }
      },
      return: async () => ({ value: undefined, done: true }),
    }
    return iterator
  })
  const push = (next: TerminalMessages | "end") => {
    queued.push(next)
    wake?.()
  }
  return { watch, push }
}

const streams = (overrides: Partial<MailStreams> = {}) => {
  const { watch, push } = streamed()
  const api = {
    watch,
    pause: vi.fn<MailStreams["pause"]>(async () => {}),
    release: vi.fn<MailStreams["release"]>(async () => {}),
    ...overrides,
  }
  return { api, push, messages: createRunnerMessages(api) }
}

describe("the runner's messages", () => {
  it("follow a terminal's threads as the runner lists them, the pause with them", async () => {
    const { messages, push } = streams()
    messages.follow(key)
    push(listing())
    await vi.waitFor(() =>
      expect(messages.state.getSnapshot().terminals[id]).toEqual({
        handle: "t1",
        agent: true,
        threads: [
          {
            id: "t-1",
            peer: "t2",
            hops: 1,
            allowed: 12,
            held: false,
            messages: [
              {
                id: "m-1",
                hop: 1,
                from: "t2",
                to: "t1",
                text: "Review a.ts.",
                sentAt: 1,
                state: "queued",
                held: null,
                deliveredAt: null,
              },
            ],
          },
        ],
      }),
    )
    push(listing({ paused: true, delivery: "unbound" }))
    await vi.waitFor(() => expect(messages.state.getSnapshot().paused).toBe(true))
    expect(messages.state.getSnapshot().terminals[id]?.agent).toBe(false)
  })

  it("take an agent whose own prompt shows, with no session bound yet, as one there", async () => {
    const { messages, push } = streams()
    messages.follow(key)
    push(listing({ delivery: "ready" }))
    await vi.waitFor(() => expect(messages.state.getSnapshot().terminals[id]?.agent).toBe(true))
  })

  it("follow each terminal once, and start over after the runner lost it", async () => {
    const { messages, push, api } = streams()
    messages.follow(key)
    messages.follow(key)
    expect(api.watch).toHaveBeenCalledTimes(1)
    push(listing())
    await vi.waitFor(() => expect(messages.state.getSnapshot().terminals[id]).toBeDefined())
    push("end")
    await vi.waitFor(() => expect(messages.state.getSnapshot().terminals[id]).toBeUndefined())
    messages.follow(key)
    expect(api.watch).toHaveBeenCalledTimes(2)
  })

  it("forget a terminal once it closes", async () => {
    const { messages, push } = streams()
    messages.follow(key)
    push(listing())
    await vi.waitFor(() => expect(messages.state.getSnapshot().terminals[id]).toBeDefined())
    messages.unfollow(key)
    expect(messages.state.getSnapshot().terminals[id]).toBeUndefined()
  })

  context("when the person releases a thread", () => {
    // The runner's answer, which the test gives when it says.
    const answering = () => {
      let answer: (() => void) | undefined
      const { messages, push, api } = streams({
        release: () => new Promise<void>((resolve) => (answer = resolve)),
      })
      return { messages, push, api, answer: () => answer?.() }
    }
    const held = (yes: boolean) => listing({ threads: [{ ...listing().threads[0]!, held: yes }] })

    it("is under way until the runner took it and a listing shows the thread go on", async () => {
      const { messages, push, answer } = answering()
      messages.follow(key)
      push(held(true))
      await vi.waitFor(() => expect(messages.state.getSnapshot().terminals[id]).toBeDefined())
      messages.release("t-1")
      expect(messages.state.getSnapshot().releasing).toEqual({ "t-1": "asked" })
      // Answered first: a listing from before still holds it.
      answer()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(messages.state.getSnapshot().releasing).toEqual({ "t-1": "accepted" })
      push(held(false))
      await vi.waitFor(() => expect(messages.state.getSnapshot().releasing).toEqual({}))
    })

    it("is under way until the runner answers, when the listing came first", async () => {
      const { messages, push, answer } = answering()
      messages.follow(key)
      push(held(true))
      await vi.waitFor(() => expect(messages.state.getSnapshot().terminals[id]).toBeDefined())
      messages.release("t-1")
      push(held(false))
      await vi.waitFor(() =>
        expect(messages.state.getSnapshot().terminals[id]?.threads[0]?.held).toBe(false),
      )
      expect(messages.state.getSnapshot().releasing).toEqual({ "t-1": "asked" })
      answer()
      await vi.waitFor(() => expect(messages.state.getSnapshot().releasing).toEqual({}))
    })

    it("forgets a failure once a listing shows the thread go on, and records none then", async () => {
      let refuse: ((error: Error) => void) | undefined
      const { messages, push } = streams({
        release: () => new Promise<void>((_, reject) => (refuse = reject)),
      })
      messages.follow(key)
      push(held(true))
      await vi.waitFor(() => expect(messages.state.getSnapshot().terminals[id]).toBeDefined())
      messages.release("t-1")
      refuse?.(new Error("lost"))
      await vi.waitFor(() =>
        expect(messages.state.getSnapshot().failed).toEqual({ "t-1": "Couldn't release it: lost" }),
      )
      // Released after all, as from another window.
      push(held(false))
      await vi.waitFor(() => expect(messages.state.getSnapshot().failed).toEqual({}))
      // A refusal for a thread already shown going on says nothing.
      messages.release("t-1")
      refuse?.(new Error("late"))
      await vi.waitFor(() => expect(messages.state.getSnapshot().releasing).toEqual({}))
      expect(messages.state.getSnapshot().failed).toEqual({})
    })

    it("lets go of a release no listing can show any more", async () => {
      const { messages, push, answer } = answering()
      messages.follow(key)
      push(held(true))
      await vi.waitFor(() => expect(messages.state.getSnapshot().terminals[id]).toBeDefined())
      messages.release("t-1")
      // The only terminal that lists the thread goes.
      messages.unfollow(key)
      expect(messages.state.getSnapshot().releasing).toEqual({})
      answer()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(messages.state.getSnapshot().releasing).toEqual({})
    })

    it("lets go of a release accepted for a thread no longer listed", async () => {
      const { messages, push, answer } = answering()
      messages.follow(key)
      push(held(true))
      await vi.waitFor(() => expect(messages.state.getSnapshot().terminals[id]).toBeDefined())
      messages.release("t-1")
      // Its thread swept from the listing before the runner answered.
      push(listing({ threads: [] }))
      await vi.waitFor(() =>
        expect(messages.state.getSnapshot().terminals[id]?.threads).toEqual([]),
      )
      answer()
      await vi.waitFor(() => expect(messages.state.getSnapshot().releasing).toEqual({}))
    })

    it("says why on that thread when the runner refused", async () => {
      const { messages } = streams({ release: () => Promise.reject(new Error("Not found")) })
      messages.release("t-1")
      await vi.waitFor(() =>
        expect(messages.state.getSnapshot()).toMatchObject({
          releasing: {},
          failed: { "t-1": "Couldn't release it: Not found" },
          error: null,
        }),
      )
      // Trying again clears it.
      messages.release("t-1")
      expect(messages.state.getSnapshot().failed).toEqual({})
    })
  })

  context("when the person pauses", () => {
    it("is paused once the runner takes it, before any listing says so", async () => {
      let answer: (() => void) | undefined
      const { messages, push } = streams({
        pause: () => new Promise<void>((resolve) => (answer = resolve)),
      })
      messages.follow(key)
      push(listing({ paused: false }))
      await vi.waitFor(() => expect(messages.state.getSnapshot().terminals[id]).toBeDefined())
      messages.pause(true)
      expect(messages.state.getSnapshot()).toMatchObject({ pending: true, paused: false })
      answer?.()
      await vi.waitFor(() =>
        expect(messages.state.getSnapshot()).toMatchObject({ pending: false, paused: true }),
      )
      // The listing that follows agrees.
      push(listing({ paused: true }))
      await vi.waitFor(() => expect(messages.state.getSnapshot().paused).toBe(true))
    })

    it("follows the listing that came before the runner's answer", async () => {
      let answer: (() => void) | undefined
      const { messages, push } = streams({
        pause: () => new Promise<void>((resolve) => (answer = resolve)),
      })
      messages.follow(key)
      messages.pause(true)
      push(listing({ paused: true }))
      await vi.waitFor(() => expect(messages.state.getSnapshot().paused).toBe(true))
      expect(messages.state.getSnapshot().pending).toBe(true)
      answer?.()
      await vi.waitFor(() =>
        expect(messages.state.getSnapshot()).toMatchObject({ pending: false, paused: true }),
      )
    })

    it("follows another window's pause, as its listings tell", async () => {
      const { messages, push } = streams()
      messages.follow(key)
      push(listing({ paused: true }))
      await vi.waitFor(() => expect(messages.state.getSnapshot().paused).toBe(true))
    })

    it("says why when the runner refused, and the switch stays as it was", async () => {
      const { messages } = streams({ pause: () => Promise.reject(new Error("closing")) })
      messages.pause(true)
      await vi.waitFor(() =>
        expect(messages.state.getSnapshot()).toMatchObject({
          pending: false,
          paused: false,
          error: "Couldn't pause messaging: closing",
        }),
      )
    })
  })
})
