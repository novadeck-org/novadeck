import type { AgentDetail, TranscriptChange, TranscriptItem } from "@novadeck/protocol"
import { RunnerError } from "@novadeck/protocol/client"
import { afterEach, beforeEach, vi } from "vitest"

import { SettleInTerminal, WordsLost } from "../../model/conversation"
import { promptRefusal } from "../../model/prompt-refusal"
import { describe, expect, it } from "../../test"
import {
  createRunnerConversations,
  graceMs,
  loadedMs,
  settleMs,
  type ConversationStreams,
} from "./conversations"

const root = "rootrootrootroot"
const sub = "subsubsubsubsubs"
const other = "otherotherother1"

const detail = (change: Partial<AgentDetail> = {}): AgentDetail => ({
  terminalId: "t",
  agent: "claude",
  sessionId: "s1",
  activity: null,
  telemetry: null,
  actors: [{ ref: root, role: "root", parent: null, type: null }],
  requests: [],
  coverage: null,
  ...change,
})

const item = (index: number, text = `text ${index}`): TranscriptItem => ({
  index,
  at: 1,
  role: "assistant",
  kind: "text",
  text,
  truncated: false,
  tool: null,
  call: null,
  author: null,
})

const batch = (...items: TranscriptItem[]): TranscriptChange => ({ type: "items", items })

// A stream the test pushes into; ends with `finish` or throws with `fail`.
const pushed = <T>() => {
  const queued: ({ value: T } | { error: unknown } | "end")[] = []
  let wake: (() => void) | undefined
  const returned = vi.fn<() => void>()
  const stream: AsyncIterableIterator<T, undefined> = {
    [Symbol.asyncIterator]: () => stream,
    next: async () => {
      // eslint-disable-next-line no-await-in-loop -- Waits for the next pushed value.
      while (!queued.length) await new Promise<void>((resolve) => (wake = resolve))
      const next = queued.shift()!
      if (next === "end") return { value: undefined, done: true }
      if ("error" in next) throw next.error
      return { value: next.value, done: false }
    },
    return: async () => {
      returned()
      return { value: undefined, done: true }
    },
  }
  const send = (next: (typeof queued)[number]) => {
    queued.push(next)
    wake?.()
  }
  return {
    stream,
    returned,
    push: (value: T) => send({ value }),
    fail: (error: unknown) => send({ error }),
    finish: () => send("end"),
  }
}

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }

const setup = () => {
  const details = pushed<AgentDetail>()
  const transcripts: Record<string, ReturnType<typeof pushed<TranscriptChange>>> = {}
  const streams = {
    detail: vi.fn<ConversationStreams["detail"]>(() => details.stream),
    transcript: vi.fn<ConversationStreams["transcript"]>((_terminal, actor) => {
      const next = pushed<TranscriptChange>()
      transcripts[actor] = next
      return next.stream
    }),
    prompt: vi.fn<ConversationStreams["prompt"]>(async () => {}),
    interrupt: vi.fn<ConversationStreams["interrupt"]>(async () => ({ returned: null })),
    answer: vi.fn<ConversationStreams["answer"]>(async () => {}),
  }
  const conversations = createRunnerConversations(streams)
  const store = conversations.conversation(key)
  return { details, transcripts, streams, conversations, store }
}

const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("the runner's conversations", () => {
  describe("reading", () => {
    it("starts with the first subscriber and gives the same store for a terminal", async () => {
      const { conversations, streams, store } = setup()
      expect(conversations.conversation(key)).toBe(store)
      expect(streams.detail).not.toHaveBeenCalled()
      const stop = store.subscribe(() => {})
      store.subscribe(() => {})
      expect(streams.detail).toHaveBeenCalledTimes(1)
      stop()
    })

    it("counts a session whose transcript stays empty as loaded after a moment", async () => {
      const { details, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      expect(store.getSnapshot()).toMatchObject({ session: "s1", loaded: false })
      await vi.advanceTimersByTimeAsync(loadedMs - 1)
      expect(store.getSnapshot().loaded).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(store.getSnapshot()).toMatchObject({ loaded: true, items: [] })
    })

    it("stops a grace period after the last subscriber left, ending its streams", async () => {
      const { details, transcripts, streams, store } = setup()
      const unsubscribe = store.subscribe(() => {})
      details.push(detail())
      await settle()
      unsubscribe()
      await vi.advanceTimersByTimeAsync(graceMs - 1)
      expect(details.returned).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(details.returned).toHaveBeenCalledTimes(1)
      expect(transcripts[root]!.returned).toHaveBeenCalledTimes(1)
      expect(store.getSnapshot().session).toBeNull()
      store.subscribe(() => {})
      expect(streams.detail).toHaveBeenCalledTimes(2)
    })

    it("goes on when a subscriber comes back within the grace period", async () => {
      const { details, streams, store } = setup()
      store.subscribe(() => {})()
      await vi.advanceTimersByTimeAsync(graceMs - 1)
      const again = store.subscribe(() => {})
      await vi.advanceTimersByTimeAsync(graceMs * 2)
      expect(streams.detail).toHaveBeenCalledTimes(1)
      expect(details.returned).not.toHaveBeenCalled()
      again()
    })

    it("ends every stream when stopped", async () => {
      const { details, transcripts, conversations, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      conversations.stop()
      expect(details.returned).toHaveBeenCalledTimes(1)
      expect(transcripts[root]!.returned).toHaveBeenCalledTimes(1)
    })
  })

  describe("following the agent", () => {
    it("takes the agent and session from the snapshot, the root's transcript as its items", async () => {
      const { details, transcripts, streams, store } = setup()
      store.subscribe(() => {})
      expect(store.getSnapshot().loaded).toBe(false)
      details.push(
        detail({
          actors: [
            { ref: sub, role: "subagent", parent: root, type: null },
            { ref: root, role: "root", parent: null, type: null },
          ],
        }),
      )
      await settle()
      expect(streams.transcript).toHaveBeenCalledWith("t", root)
      transcripts[root]!.push(batch(item(0), item(1)))
      await settle()
      const now = store.getSnapshot()
      expect(now).toMatchObject({ agent: "claude", session: "s1", loaded: true })
      expect(now.items.map((each) => each.id)).toEqual(["s1:0", "s1:1"])
      expect(now.items[1]).toEqual({
        id: "s1:1",
        at: 1,
        role: "assistant",
        kind: "text",
        text: "text 1",
        truncated: false,
        tool: null,
        call: null,
        author: null,
      })
    })

    it("maps requests, marking those of a subagent", async () => {
      const { details, store } = setup()
      store.subscribe(() => {})
      details.push(
        detail({
          actors: [
            { ref: root, role: "root", parent: null, type: null },
            { ref: sub, role: "subagent", parent: root, type: null },
          ],
          requests: [
            {
              ref: "req1req1req1req1",
              actor: root,
              kind: "permission",
              tool: "Bash",
              subject: "ls",
              choices: ["Yes", "No"],
              dialog: {
                type: "choices",
                id: "d1",
                title: "Run it?",
                detail: "ls -la",
                options: [
                  { id: "1", label: "Yes", text: null },
                  { id: "2", label: "No", text: "prompt" },
                ],
              },
              answered: false,
            },
            {
              ref: "req2req2req2req2",
              actor: sub,
              kind: "question",
              tool: "Ask",
              subject: null,
              choices: [],
              dialog: null,
              answered: false,
            },
          ],
        }),
      )
      await settle()
      expect(store.getSnapshot().requests).toEqual([
        {
          id: "req1req1req1req1",
          kind: "permission",
          tool: "Bash",
          subject: "ls",
          choices: ["Yes", "No"],
          subagent: false,
          dialog: {
            type: "choices",
            id: "d1",
            title: "Run it?",
            detail: "ls -la",
            options: [
              { id: "1", label: "Yes", text: null },
              { id: "2", label: "No", text: "prompt" },
            ],
          },
          answered: false,
        },
        {
          id: "req2req2req2req2",
          kind: "question",
          tool: "Ask",
          subject: null,
          choices: [],
          subagent: true,
          dialog: null,
          answered: false,
        },
      ])
    })

    it("shows a dialog that turned raw, and keeps the store for one that read the same", async () => {
      const { details, store } = setup()
      const listener = vi.fn<() => void>()
      store.subscribe(listener)
      const asking = (dialog: AgentDetail["requests"][number]["dialog"], answered = false) =>
        detail({
          requests: [
            {
              ref: "req1req1req1req1",
              actor: root,
              kind: "permission",
              tool: "Bash",
              subject: "ls",
              choices: ["Yes"],
              dialog,
              answered,
            },
          ],
        })
      const choices: AgentDetail["requests"][number]["dialog"] = {
        type: "choices",
        id: "d1",
        title: null,
        detail: null,
        options: [{ id: "1", label: "Yes", text: null }],
      }
      details.push(asking(choices))
      await settle()
      const before = store.getSnapshot()
      listener.mockClear()
      details.push(
        asking({
          type: "choices",
          id: "d1",
          title: null,
          detail: null,
          options: [{ id: "1", label: "Yes", text: null }],
        }),
      )
      await settle()
      expect(store.getSnapshot()).toBe(before)
      expect(listener).not.toHaveBeenCalled()
      details.push(asking({ type: "raw", text: "Allow?", reason: "failed" }))
      await settle()
      expect(store.getSnapshot().requests[0]?.dialog).toEqual({
        type: "raw",
        text: "Allow?",
        reason: "failed",
      })
      details.push(asking(choices, true))
      await settle()
      expect(store.getSnapshot().requests[0]?.answered).toBe(true)
    })

    it("keeps the items and notifies nobody for a snapshot that changes nothing", async () => {
      const { details, transcripts, store } = setup()
      const listener = vi.fn<() => void>()
      store.subscribe(listener)
      details.push(detail())
      await settle()
      transcripts[root]!.push(batch(item(0)))
      await settle()
      const before = store.getSnapshot()
      listener.mockClear()
      details.push(detail({ activity: null }))
      await settle()
      expect(store.getSnapshot()).toBe(before)
      expect(listener).not.toHaveBeenCalled()
    })

    it("starts over for a new root: ends the old transcript, clears the items", async () => {
      const { details, transcripts, streams, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      transcripts[root]!.push(batch(item(0)))
      await settle()
      details.push(
        detail({
          sessionId: "s2",
          actors: [{ ref: other, role: "root", parent: null, type: null }],
        }),
      )
      await settle()
      expect(transcripts[root]!.returned).toHaveBeenCalledTimes(1)
      expect(streams.transcript).toHaveBeenLastCalledWith("t", other)
      expect(store.getSnapshot()).toMatchObject({ session: "s2", loaded: false, items: [] })
      transcripts[other]!.push(batch(item(0)))
      await settle()
      expect(store.getSnapshot().items.map((each) => each.id)).toEqual(["s2:0"])
    })

    it("has no conversation once the agent leaves, and waits for the next snapshot", async () => {
      const { details, transcripts, streams, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      transcripts[root]!.push(batch(item(0)))
      transcripts[root]!.finish()
      await settle()
      expect(store.getSnapshot().items).toHaveLength(1)
      expect(streams.transcript).toHaveBeenCalledTimes(1)
      details.push(detail({ agent: null, sessionId: null, actors: [] }))
      await settle()
      expect(store.getSnapshot()).toMatchObject({ agent: null, session: null, items: [] })
      details.push(detail({ sessionId: "s3" }))
      await settle()
      expect(streams.transcript).toHaveBeenCalledTimes(2)
    })
  })

  describe("the items", () => {
    it("replace everything from an item's index on", async () => {
      const { details, transcripts, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      transcripts[root]!.push(batch(item(0), item(1), item(2)))
      transcripts[root]!.push(batch(item(1, "again")))
      await settle()
      expect(store.getSnapshot().items.map((each) => each.text)).toEqual(["text 0", "again"])
    })

    it("update once per batch, as immutable snapshots", async () => {
      const { details, transcripts, store } = setup()
      const listener = vi.fn<() => void>()
      store.subscribe(listener)
      details.push(detail())
      await settle()
      listener.mockClear()
      const before = store.getSnapshot()
      transcripts[root]!.push(batch(item(0), item(1), item(2)))
      await settle()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(before.items).toEqual([])
    })

    it("stay on show through a reset, and a full read again replaces them at once", async () => {
      const { details, transcripts, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      transcripts[root]!.push(batch(item(0), item(1), item(2)))
      await settle()
      transcripts[root]!.push({ type: "reset" })
      await settle()
      expect(store.getSnapshot().items).toHaveLength(3)
      transcripts[root]!.push(batch(item(0, "new"), item(1, "new")))
      await settle()
      expect(store.getSnapshot().items.map((each) => each.text)).toEqual([
        "text 0",
        "text 1",
        "text 2",
      ])
      transcripts[root]!.push(batch(item(2, "new")))
      await settle()
      expect(store.getSnapshot().items.map((each) => each.text)).toEqual(["new", "new", "new"])
    })

    it("settle to a shorter list once the read again is quiet", async () => {
      const { details, transcripts, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      transcripts[root]!.push(batch(item(0), item(1), item(2)))
      await settle()
      transcripts[root]!.push({ type: "reset" })
      transcripts[root]!.push(batch(item(0, "new"), item(1, "new")))
      await vi.advanceTimersByTimeAsync(settleMs - 1)
      expect(store.getSnapshot().items).toHaveLength(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(store.getSnapshot().items.map((each) => each.text)).toEqual(["new", "new"])
    })

    it("are kept when no batch follows a reset", async () => {
      const { details, transcripts, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      transcripts[root]!.push(batch(item(0), item(1)))
      await settle()
      transcripts[root]!.push({ type: "reset" })
      await vi.advanceTimersByTimeAsync(settleMs * 4)
      expect(store.getSnapshot().items).toHaveLength(2)
    })

    it("are loaded with none when the transcript is not found", async () => {
      const { details, transcripts, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      transcripts[root]!.fail(new RunnerError("NOT_FOUND"))
      await settle()
      expect(store.getSnapshot()).toMatchObject({ loaded: true, items: [] })
    })

    it("are loaded with none when the transcript ends with nothing", async () => {
      const { details, transcripts, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      transcripts[root]!.finish()
      await settle()
      expect(store.getSnapshot()).toMatchObject({ loaded: true, items: [] })
    })
  })

  describe("sending", () => {
    it("gives the prompt to the runner and stops the turn on interrupt", async () => {
      const { conversations, streams } = setup()
      await conversations.send(key, "hello")
      await conversations.interrupt(key)
      expect(streams.prompt).toHaveBeenCalledWith("t", "hello")
      expect(streams.interrupt).toHaveBeenCalledWith("t")
    })

    it.each([
      ["DISCONNECTED", "The runner is offline."],
      ["CLOSED", "The runner is offline."],
      ["CONFLICT", "The agent can't take that right now. Check its terminal."],
      ["PROMPT_REFUSED", promptRefusal],
      ["PROMPT_FAILED", "The prompt didn't land in the agent's box. It may be there as a draft."],
      ["INTERNAL_SERVER_ERROR", "Couldn't reach the agent."],
    ] as const)("tells the person why a %s failure didn't go", async (code, message) => {
      const { conversations, streams } = setup()
      streams.prompt.mockRejectedValue(new RunnerError(code))
      await expect(conversations.send(key, "hi")).rejects.toThrow(message)
    })

    it("words a conflict by the reason the runner gives, offering the terminal where it settles there", async () => {
      const { conversations, streams } = setup()
      const failing = async (data: unknown): Promise<unknown> => {
        streams.prompt.mockRejectedValueOnce(
          new RunnerError("CONFLICT", "The runner's own words", { data }),
        )
        return conversations.send(key, "hi").catch((failure: unknown) => failure)
      }
      const draft = await failing({ reason: "draft" })
      expect(draft).toBeInstanceOf(SettleInTerminal)
      expect(draft).toHaveProperty("message", expect.stringContaining("already holds text"))
      const ringing = await failing({ reason: "ringing" })
      expect(ringing).not.toBeInstanceOf(SettleInTerminal)
      expect(ringing).toHaveProperty("message", expect.stringContaining("in a moment"))
      // A reason this client doesn't know is none: the terminal is where to look.
      const unknown = await failing({ reason: "new-one" })
      expect(unknown).toBeInstanceOf(SettleInTerminal)
      expect(unknown).toHaveProperty("message", expect.not.stringContaining("own words"))
      const none = await failing({ reason: "no-agent" })
      expect(none).toBeInstanceOf(SettleInTerminal)
      expect(none).toHaveProperty("message", "No agent is running in this terminal.")
    })

    it("says the runner's own reason for a refused prompt, where it gives one", async () => {
      const { conversations, streams } = setup()
      streams.prompt.mockRejectedValue(
        new RunnerError("PROMPT_REFUSED", "A message can't hold control characters."),
      )
      await expect(conversations.send(key, "hi")).rejects.toThrow("control characters")
      streams.prompt.mockRejectedValue(new RunnerError("PROMPT_REFUSED"))
      await expect(conversations.send(key, "hi")).rejects.toThrow("can't start with / or !")
    })

    it("refuses a message's shape as the protocol's rule does, blank text aside", () => {
      const { conversations } = setup()
      expect(conversations.refused("/tmp is full")).toBe(true)
      expect(conversations.refused("look at @src")).toBe(true)
      expect(conversations.refused("!ls")).toBe(true)
      expect(conversations.refused("!ls", { shell: true })).toBe(false)
      expect(conversations.refused("!", { shell: true })).toBe(true)
      expect(conversations.refused("tmp is full")).toBe(false)
      // Nothing to warn of yet: the chat sends no empty message.
      expect(conversations.refused(" \r\n")).toBe(false)
    })

    it("gives back the words the agent returned from its queue, or null", async () => {
      const { conversations, streams } = setup()
      expect(await conversations.interrupt(key)).toBeNull()
      streams.interrupt.mockResolvedValueOnce({ returned: "Queued beta" })
      expect(await conversations.interrupt(key)).toBe("Queued beta")
      streams.interrupt.mockRejectedValueOnce(new RunnerError("BOX_NOT_CLEARED"))
      await expect(conversations.interrupt(key)).rejects.toThrow("still in the agent's box")
    })

    it("tells the person why an interrupt didn't go", async () => {
      const { conversations, streams } = setup()
      streams.interrupt.mockRejectedValue(
        new RunnerError("CONFLICT", "No agent is running in this terminal.", {
          data: { reason: "no-box" },
        }),
      )
      await expect(conversations.interrupt(key)).rejects.toThrow("can't find the agent's input box")
      streams.interrupt.mockRejectedValue(
        new RunnerError("CONFLICT", "A request waits.", { data: { reason: "pending" } }),
      )
      await expect(conversations.interrupt(key)).rejects.toThrow("Answer it first, then stop it")
      streams.interrupt.mockRejectedValue(
        new RunnerError("CONFLICT", "Ringing.", { data: { reason: "ringing" } }),
      )
      await expect(conversations.interrupt(key)).rejects.toThrow("Stop it again in a moment")
      streams.interrupt.mockRejectedValue(new Error("boom"))
      await expect(conversations.interrupt(key)).rejects.toThrow("Couldn't stop the agent.")
    })
  })

  describe("answering", () => {
    it("gives the answer to the runner for the terminal's request", async () => {
      const { conversations, streams } = setup()
      await conversations.answer(key, "req1req1req1req1", {
        type: "choice",
        dialog: "d1",
        option: "1",
      })
      expect(streams.answer).toHaveBeenCalledWith("t", "req1req1req1req1", {
        type: "choice",
        dialog: "d1",
        option: "1",
      })
    })

    it("tells a runner's WORDS_NOT_SENT as words that didn't follow the answer", async () => {
      const { conversations, streams } = setup()
      streams.answer.mockRejectedValue(new RunnerError("WORDS_NOT_SENT"))
      await expect(
        conversations.answer(key, "r", { type: "chat", dialog: "q1", text: "why" }),
      ).rejects.toBeInstanceOf(WordsLost)
    })

    it("tells an answer that took but whose words didn't from one that didn't take", async () => {
      const { conversations, streams } = setup()
      streams.answer.mockRejectedValue(
        new RunnerError(
          "WORDS_NOT_SENT",
          "The answer took, but the agent did not take the words that follow it.",
        ),
      )
      await expect(
        conversations.answer(key, "r", { type: "chat", dialog: "q1", text: "why" }),
      ).rejects.toBeInstanceOf(WordsLost)
    })

    it("passes a chat about the questions on", async () => {
      const { conversations, streams } = setup()
      await conversations.answer(key, "req1req1req1req1", {
        type: "chat",
        dialog: "q1",
        text: "why",
      })
      expect(streams.answer).toHaveBeenCalledWith("t", "req1req1req1req1", {
        type: "chat",
        dialog: "q1",
        text: "why",
      })
    })

    it("passes a form's values on as they are typed", async () => {
      const { conversations, streams } = setup()
      await conversations.answer(key, "req1req1req1req1", {
        type: "form",
        dialog: "f1",
        action: "accept",
        values: { name: "api", replicas: 3, dry: true },
      })
      expect(streams.answer).toHaveBeenCalledWith("t", "req1req1req1req1", {
        type: "form",
        dialog: "f1",
        action: "accept",
        values: { name: "api", replicas: 3, dry: true },
      })
    })

    it("words an answer's conflict by its reason, where the runner gives one", async () => {
      const { conversations, streams } = setup()
      streams.answer.mockRejectedValue(
        new RunnerError("CONFLICT", "A message's doorbell is ringing the agent.", {
          data: { reason: "ringing" },
        }),
      )
      await expect(
        conversations.answer(key, "r", { type: "choice", dialog: "d1", option: "1" }),
      ).rejects.toThrow("Try the answer again in a moment")
    })

    it.each([
      ["DISCONNECTED", "The runner is offline."],
      ["CONFLICT", "Couldn't answer that here. Answer it in the terminal."],
      ["DIALOG_CHANGED", "The dialog changed — check it and answer again."],
      ["PROMPT_REFUSED", promptRefusal],
      ["ANSWER_FAILED", "That answer didn't take. Answer it in the terminal."],
      ["NOT_FOUND", "That request is already answered."],
      ["INTERNAL_SERVER_ERROR", "Couldn't answer for the agent."],
    ] as const)("tells the person why a %s failure didn't take", async (code, message) => {
      const { conversations, streams } = setup()
      streams.answer.mockRejectedValue(new RunnerError(code))
      await expect(
        conversations.answer(key, "r", { type: "choice", dialog: "d1", option: "1" }),
      ).rejects.toThrow(message)
    })
  })
})
