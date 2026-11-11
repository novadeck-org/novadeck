import {
  noConversation,
  returnedBy,
  RingUnderWay,
  SettleInTerminal,
  WordsLost,
} from "@novadeck/core/conversation"
import { promptRefusal } from "@novadeck/core/conversation/prompt-refusal"
import { noMessages, type MessagesState } from "@novadeck/core/messages"
import { createStore } from "@novadeck/core/store"
import { terminalKeyPath } from "@novadeck/core/types"
import type { AgentDetail, SliceChange, TranscriptChange, TranscriptItem } from "@novadeck/protocol"
import { WireError } from "@novadeck/wire"
import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { channel } from "../testing/channel"
import {
  createRunnerConversations,
  enterGapMs,
  failuresToLoaded,
  graceMs,
  loadedMs,
  retryMaxMs,
  retryMs,
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
  prompts: [],
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
  run: null,
  outcome: null,
  scripted: false,
  interrupted: false,
  ring: null,
})

const batch = (...items: TranscriptItem[]): TranscriptChange => ({ type: "items", items })

// A stream the test pushes into; ends with `finish` or throws with `fail`.
const key = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }

const setup = () => {
  const details = channel<AgentDetail>()
  const slices = channel<SliceChange>()
  const transcripts: Record<string, ReturnType<typeof channel<TranscriptChange>>> = {}
  const streams = {
    detail: vi.fn<ConversationStreams["detail"]>(() => details.iterator),
    slice: vi.fn<ConversationStreams["slice"]>(() => slices.iterator),
    keys: vi.fn<ConversationStreams["keys"]>(async () => {}),
    transcript: vi.fn<ConversationStreams["transcript"]>((_terminal, actor) => {
      const next = channel<TranscriptChange>()
      transcripts[actor] = next
      return next.iterator
    }),
    transcriptImage: vi.fn<ConversationStreams["transcriptImage"]>(async () => ({
      state: "ready",
      mime: "image/png",
      src: "data:image/png;base64,AAAA",
    })),
    prompt: vi.fn<ConversationStreams["prompt"]>(async (_terminal, _text, options) => ({
      ref: options?.ref ?? "runner-picked-ref",
      tracked: true,
    })),
    upload: vi.fn<ConversationStreams["upload"]>(async (_terminal, file) => `/runner/${file.name}`),
    interrupt: vi.fn<ConversationStreams["interrupt"]>(async () => ({ returned: null })),
    takeBox: vi.fn<ConversationStreams["takeBox"]>(async () => ({ returned: null })),
    clearBox: vi.fn<ConversationStreams["clearBox"]>(async () => ({ cleared: true })),
    putBox: vi.fn<ConversationStreams["putBox"]>(async () => ({ placed: false })),
    answer: vi.fn<ConversationStreams["answer"]>(async () => {}),
  }
  const conversations = createRunnerConversations(streams)
  const store = conversations.conversation(key)
  return { details, slices, transcripts, streams, conversations, store }
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

    it("carries the terminal's live slice, through a new snapshot of the agent", async () => {
      const { details, slices, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      expect(store.getSnapshot().slice).toBeNull()
      const slice = {
        reason: "menu" as const,
        columns: 80,
        rows: [],
        cursor: null,
        secret: false,
      }
      slices.push({ slice })
      await settle()
      expect(store.getSnapshot().slice).toEqual(slice)
      details.push(detail())
      await settle()
      expect(store.getSnapshot().slice).toEqual(slice)
      slices.push({ slice: null })
      await settle()
      expect(store.getSnapshot().slice).toBeNull()
    })

    it("ends the slice's stream with the others", async () => {
      const { details, slices, store } = setup()
      const unsubscribe = store.subscribe(() => {})
      details.push(detail())
      await settle()
      unsubscribe()
      await vi.advanceTimersByTimeAsync(graceMs)
      expect(slices.returned()).toBe(1)
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
      expect(details.returned()).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(details.returned()).toBe(1)
      expect(transcripts[root]!.returned()).toBe(1)
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
      expect(details.returned()).toBe(0)
      again()
    })

    it("ends every stream when stopped", async () => {
      const { details, transcripts, conversations, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      conversations.stop()
      expect(details.returned()).toBe(1)
      expect(transcripts[root]!.returned()).toBe(1)
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
        run: null,
        outcome: null,
        scripted: false,
        interrupted: false,
        ring: null,
      })
    })

    it("carries a call's run and an interrupted item as they came", async () => {
      const { details, transcripts, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      const run = { kind: "run", title: "Ran", detail: "pnpm test" } as const
      transcripts[root]!.push(
        batch(
          { ...item(0), kind: "tool-call", tool: "Bash", run },
          { ...item(1), role: "user", interrupted: true },
        ),
      )
      await settle()
      const { items } = store.getSnapshot()
      expect(items.map((each) => [each.run, each.interrupted])).toEqual([
        [run, false],
        [null, true],
      ])
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
              askedAt: 1_700_000_000_000,
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
              askedAt: 1_700_000_005_000,
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
          askedAt: 1_700_000_000_000,
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
          askedAt: 1_700_000_005_000,
        },
      ])
    })

    it("marks those the runner says ask without waiting", async () => {
      const { details, store } = setup()
      store.subscribe(() => {})
      const asked = (ref: string, detached = false): AgentDetail["requests"][number] => ({
        ...(detached && { detached: true as const }),
        ref,
        actor: root,
        kind: "question",
        tool: "request_user_input",
        subject: null,
        choices: [],
        dialog: { type: "questions", id: `${ref}:d`, chat: "prompt", questions: [] },
        answered: false,
        askedAt: 1,
      })
      details.push(
        detail({
          activity: {
            state: "working",
            background: null,
            planning: false,
            waiting: null,
            attention: { pending: 3, kind: "question", detached: 2 },
            subagents: [],
            lastTurn: null,
          },
          // In any order: the runner marks each one.
          requests: [
            asked("det1det1det1det1", true),
            asked("holdholdholdhold"),
            asked("det2det2det2det2", true),
          ],
        }),
      )
      await settle()
      expect(store.getSnapshot().requests.map(({ id, detached }) => [id, detached])).toEqual([
        ["det1det1det1det1", true],
        ["holdholdholdhold", undefined],
        ["det2det2det2det2", true],
      ])
    })

    it.each(["claude", "codex", "agy"] as const)(
      "passes the runner's request time through for %s, and follows a change of it",
      async (agent) => {
        const { details, store } = setup()
        store.subscribe(() => {})
        const asking = (askedAt: number) =>
          detail({
            agent,
            requests: [
              {
                ref: "req1req1req1req1",
                actor: root,
                kind: "permission",
                tool: "Bash",
                subject: "ls",
                choices: ["Yes"],
                dialog: null,
                answered: false,
                askedAt,
              },
            ],
          })
        details.push(asking(1_700_000_000_000))
        await settle()
        expect(store.getSnapshot().requests[0]?.askedAt).toBe(1_700_000_000_000)
        details.push(asking(1_700_000_009_000))
        await settle()
        expect(store.getSnapshot().requests[0]?.askedAt).toBe(1_700_000_009_000)
      },
    )

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
              askedAt: 1,
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
      expect(transcripts[root]!.returned()).toBe(1)
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
      transcripts[root]!.end()
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

    it("carry the images a prompt listed, and none an item lacks", async () => {
      const { details, transcripts, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      const images = [{ offset: 90, index: 0, mime: "image/png" }]
      transcripts[root]!.push(batch({ ...item(0), images }, item(1)))
      await settle()
      const [first, second] = store.getSnapshot().items
      expect(first!.images).toEqual(images)
      expect(second).not.toHaveProperty("images")
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

    it("stay loading while the transcript is not found, and load once it is", async () => {
      const { details, transcripts, streams, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      transcripts[root]!.fail(new WireError("NOT_FOUND"))
      await settle()
      // Not "nothing said yet": the runner may not know the transcript yet.
      expect(store.getSnapshot()).toMatchObject({ loaded: false, items: [] })
      expect(streams.transcript).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(retryMs)
      expect(streams.transcript).toHaveBeenCalledTimes(2)
      transcripts[root]!.push(batch(item(0), item(1)))
      await settle()
      expect(store.getSnapshot()).toMatchObject({ loaded: true })
      expect(store.getSnapshot().items).toHaveLength(2)
    })

    it("count as none after a few reads in a row failed, and are still asked again", async () => {
      const { details, transcripts, streams, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      let wait = retryMs
      for (let failure = 1; failure <= failuresToLoaded; failure += 1) {
        transcripts[root]!.fail(new WireError("NOT_FOUND"))
        // eslint-disable-next-line no-await-in-loop -- Each failure follows the wait before it.
        await settle()
        expect(store.getSnapshot().loaded).toBe(failure >= failuresToLoaded)
        // eslint-disable-next-line no-await-in-loop -- Each failure follows the wait before it.
        await vi.advanceTimersByTimeAsync(wait)
        wait = Math.min(wait * 2, retryMaxMs)
      }
      expect(streams.transcript).toHaveBeenCalledTimes(failuresToLoaded + 1)
      transcripts[root]!.push(batch(item(0)))
      await settle()
      expect(store.getSnapshot().items).toHaveLength(1)
    })

    it("are read again at the next snapshot of the same session, replacing what showed", async () => {
      const { details, transcripts, streams, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      transcripts[root]!.push(batch(item(0, "old"), item(1, "old")))
      await settle()
      transcripts[root]!.fail(new WireError("CONNECTION_LOST"))
      await settle()
      expect(store.getSnapshot().items).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(retryMs)
      details.push(detail({ activity: null, requests: [] }))
      await settle()
      expect(streams.transcript).toHaveBeenCalledTimes(2)
      transcripts[root]!.push(batch(item(0, "new")))
      await settle()
      // It replaces what showed once it is as long, or quiet for a while.
      expect(store.getSnapshot().items).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(settleMs)
      expect(store.getSnapshot().items.map(({ text }) => text)).toEqual(["new"])
    })

    it("are asked for no oftener than once a wait, however many snapshots come", async () => {
      const { details, transcripts, streams, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      transcripts[root]!.fail(new WireError("NOT_FOUND"))
      await settle()
      for (let at = 0; at < 20; at += 1) {
        details.push(detail({ prompts: [] }))
        // eslint-disable-next-line no-await-in-loop -- Snapshots arrive over a second.
        await vi.advanceTimersByTimeAsync(50)
      }
      // The snapshots pulled the wait in to its first end, and no further.
      expect(streams.transcript).toHaveBeenCalledTimes(2)
    })

    it("stay loading for the time a few reads take, however many snapshots come", async () => {
      const { details, transcripts, streams, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      const started = Date.now()
      while (streams.transcript.mock.calls.length <= failuresToLoaded + 2) {
        transcripts[root]!.fail(new WireError("NOT_FOUND"))
        // eslint-disable-next-line no-await-in-loop -- Fails every read as it opens.
        await settle()
        if (store.getSnapshot().loaded) break
        details.push(detail({ prompts: [] }))
        // eslint-disable-next-line no-await-in-loop -- Snapshots keep coming meanwhile.
        await vi.advanceTimersByTimeAsync(100)
      }
      expect(store.getSnapshot().loaded).toBe(true)
      expect(Date.now() - started).toBeGreaterThanOrEqual(2 * retryMs)
    })

    it("keeps what shows through a read again until it is as long", async () => {
      const { details, transcripts, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      transcripts[root]!.push(batch(...Array.from({ length: 300 }, (_, at) => item(at))))
      await settle()
      transcripts[root]!.fail(new WireError("CONNECTION_LOST"))
      await settle()
      await vi.advanceTimersByTimeAsync(retryMs)
      transcripts[root]!.push(batch(...Array.from({ length: 256 }, (_, at) => item(at))))
      await settle()
      expect(store.getSnapshot().items).toHaveLength(300)
      transcripts[root]!.push(batch(...Array.from({ length: 50 }, (_, at) => item(256 + at))))
      await settle()
      expect(store.getSnapshot().items).toHaveLength(306)
    })

    it("go on backing off for a read that fails after the same items every time", async () => {
      const { details, transcripts, streams, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      const first = () => {
        transcripts[root]!.push(batch(item(0), item(1)))
        transcripts[root]!.fail(new WireError("CONNECTION_LOST"))
      }
      first()
      await settle()
      await vi.advanceTimersByTimeAsync(retryMs)
      first()
      await settle()
      // Nothing beyond what showed: this failure counts, and the next wait doubles.
      await vi.advanceTimersByTimeAsync(retryMs)
      expect(streams.transcript).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(retryMs)
      expect(streams.transcript).toHaveBeenCalledTimes(3)
    })

    it("stop being asked for once the session changes or the reading stops", async () => {
      const { details, transcripts, streams, conversations, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      transcripts[root]!.fail(new WireError("NOT_FOUND"))
      await settle()
      details.push(detail({ sessionId: "s2" }))
      await settle()
      expect(streams.transcript).toHaveBeenCalledTimes(2)
      transcripts[root]!.fail(new WireError("NOT_FOUND"))
      await settle()
      conversations.stop()
      await vi.advanceTimersByTimeAsync(retryMaxMs * 2)
      expect(streams.transcript).toHaveBeenCalledTimes(2)
    })

    it("are loaded with none when the transcript ends with nothing", async () => {
      const { details, transcripts, store } = setup()
      store.subscribe(() => {})
      details.push(detail())
      await settle()
      transcripts[root]!.end()
      await settle()
      expect(store.getSnapshot()).toMatchObject({ loaded: true, items: [] })
    })
  })

  describe("a prompt's images", () => {
    const image = { offset: 90, index: 1, mime: null }
    const opened = async () => {
      const made = setup()
      made.store.subscribe(() => {})
      made.details.push(detail())
      await settle()
      return made
    }

    it("are asked of the runner by the conversation's session, offset and index, and answered as a data URL", async () => {
      const { conversations, streams, store } = await opened()
      await expect(conversations.image?.(key, image)).resolves.toBe("data:image/png;base64,AAAA")
      expect(streams.transcriptImage).toHaveBeenCalledWith("t", {
        sessionId: store.getSnapshot().session,
        offset: 90,
        index: 1,
      })
      expect(store.getSnapshot().session).not.toBeNull()
    })

    it("are none where the runner has no picture", async () => {
      const { conversations, streams } = await opened()
      streams.transcriptImage.mockResolvedValueOnce({ state: "unavailable", reason: "too-large" })
      await expect(conversations.image?.(key, image)).resolves.toBeNull()
    })

    it("fail where the runner could not be asked, the session moved on or none is open, for the chat to ask again", async () => {
      const { conversations, streams } = await opened()
      streams.transcriptImage.mockRejectedValueOnce(new WireError("DISCONNECTED"))
      await expect(conversations.image?.(key, image)).rejects.toThrow("couldn't show it")
      streams.transcriptImage.mockRejectedValueOnce(new WireError("NOT_FOUND"))
      await expect(conversations.image?.(key, image)).rejects.toThrow("couldn't show it")
      const idle = setup()
      await expect(idle.conversations.image?.(key, image)).rejects.toThrow("isn't open")
      expect(idle.streams.transcriptImage).not.toHaveBeenCalled()
    })
  })

  describe("the agent's box", () => {
    it("shows what it holds, as the detail says, and nothing once it's empty", async () => {
      const { details, store } = setup()
      store.subscribe(() => {})
      const box = { text: "half typed", mode: "prompt", tail: true, known: false } as const
      details.push(detail({ box }))
      await settle()
      expect(store.getSnapshot().box).toEqual(box)
      const held = store.getSnapshot()
      details.push(detail({ box: { ...box } }))
      await settle()
      expect(store.getSnapshot()).toBe(held)
      details.push(detail({ box: null }))
      await settle()
      expect(store.getSnapshot().box).toBeNull()
    })

    it("takes a runner that sends none for nothing to show", async () => {
      const { details, store } = setup()
      store.subscribe(() => {})
      details.push(detail({}))
      await settle()
      expect(store.getSnapshot().box).toBeNull()
    })
  })

  describe("keys", () => {
    it("writes them in order, each after the one before", async () => {
      const { streams, conversations } = setup()
      const seen: string[] = []
      let release = (): void => {}
      streams.keys.mockImplementation(async (_terminal, keys) => {
        seen.push(keys)
        if (keys === "/") await new Promise<void>((resolve) => (release = resolve))
      })
      void conversations.keys?.(key, "/")
      void conversations.keys?.(key, "m")
      await settle()
      expect(seen).toEqual(["/"])
      release()
      await settle()
      expect(seen).toEqual(["/", "m"])
    })

    it("holds Enter a moment behind the keys before it", async () => {
      const { streams, conversations } = setup()
      void conversations.keys?.(key, "/model")
      await settle()
      void conversations.keys?.(key, "\r")
      await settle()
      expect(streams.keys).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(enterGapMs)
      expect(streams.keys).toHaveBeenLastCalledWith("t", "\r")
    })

    it("goes on after a key that failed, and says so", async () => {
      const { streams, conversations } = setup()
      streams.keys.mockRejectedValueOnce(new Error("gone"))
      await expect(conversations.keys?.(key, "/")).rejects.toThrow()
      await conversations.keys?.(key, "m")
      expect(streams.keys).toHaveBeenLastCalledWith("t", "m")
    })
  })

  describe("sending", () => {
    it("gives a failure the words it took out of the agent's box, whatever it was", async () => {
      const { conversations, streams } = setup()
      streams.prompt.mockRejectedValueOnce(
        new WireError("PROMPT_FAILED", undefined, { data: { returned: "came back" } }),
      )
      await expect(conversations.send(key, "hello")).rejects.toMatchObject({
        returned: "came back",
      })
      streams.prompt.mockRejectedValueOnce(
        new WireError("CONFLICT", undefined, { data: { reason: "pending", returned: "!ls" } }),
      )
      const conflict = await conversations.send(key, "hello").catch((error: unknown) => error)
      expect(conflict).toMatchObject({ returned: "!ls" })
      expect(returnedBy(conflict)).toBe("!ls")
      expect(returnedBy(new Error("plain"))).toBeUndefined()
    })

    it("takes the agent's box, and puts in it, leaving words where they are on a failure", async () => {
      const { conversations, streams } = setup()
      streams.takeBox.mockResolvedValueOnce({ returned: "words" })
      await expect(conversations.takeBox?.(key)).resolves.toEqual({ words: "words" })
      streams.takeBox.mockRejectedValueOnce(new WireError("CONFLICT"))
      await expect(conversations.takeBox?.(key)).resolves.toEqual({ words: null })
      streams.takeBox.mockResolvedValueOnce({ returned: null, images: ["/runner/a.png"] })
      await expect(conversations.takeBox?.(key)).resolves.toEqual({
        words: null,
        images: ["/runner/a.png"],
      })
      streams.putBox.mockResolvedValueOnce({ placed: true })
      await expect(conversations.putBox?.(key, "draft")).resolves.toBe(true)
      expect(streams.putBox).toHaveBeenCalledWith("t", "draft")
      streams.putBox.mockRejectedValueOnce(new WireError("CONFLICT"))
      await expect(conversations.putBox?.(key, "draft")).resolves.toBe(false)
    })

    it("carries the terminal's doorbell, as its messages change, for as long as it's read", async () => {
      const { streams } = setup()
      const messages = createStore<MessagesState>(noMessages)
      const conversations = createRunnerConversations(streams, undefined, messages)
      const threads = (ringing: boolean) => ({
        ...noMessages,
        terminals: {
          [terminalKeyPath(key)]: { handle: "moth", agent: true, ringing, threads: [] },
        },
      })
      messages.update(() => threads(false))
      const conversation = conversations.conversation(key)
      const stop = conversation.subscribe(() => {})
      expect(conversation.getSnapshot().doorbell.ringing).toBe(false)
      messages.update(() => threads(true))
      expect(conversation.getSnapshot().doorbell.ringing).toBe(true)
      stop()
    })

    it("clears the agent's box, a failure telling why", async () => {
      const { conversations, streams } = setup()
      streams.clearBox.mockResolvedValueOnce({ cleared: true })
      await expect(conversations.clearBox?.(key, "/model")).resolves.toBe(true)
      expect(streams.clearBox).toHaveBeenCalledWith("t", "/model")
      streams.clearBox.mockResolvedValueOnce({ cleared: false })
      await expect(conversations.clearBox?.(key, "/model")).resolves.toBe(false)
      streams.clearBox.mockRejectedValueOnce(
        new WireError("CONFLICT", "The runner's own words", { data: { reason: "pending" } }),
      )
      await expect(conversations.clearBox?.(key, "/model")).rejects.toThrow(
        "waiting for your answer",
      )
    })

    it("hands on the words a prompt took out of the agent's box", async () => {
      const { conversations, streams } = setup()
      streams.prompt.mockResolvedValueOnce({ ref: "r", tracked: true, returned: "came back" })
      await expect(conversations.send(key, "hello")).resolves.toEqual({
        tracked: true,
        returned: "came back",
      })
    })

    it("gives the prompt to the runner and stops the turn on interrupt", async () => {
      const { conversations, streams } = setup()
      await expect(conversations.send(key, "hello")).resolves.toEqual({
        tracked: true,
        returned: null,
      })
      await conversations.interrupt(key)
      expect(streams.prompt).toHaveBeenCalledWith("t", "hello", undefined)
      expect(streams.interrupt).toHaveBeenCalledWith("t", undefined)
    })

    it("asks the runner to set a question aside for the person's own Send and Stop", async () => {
      const { conversations, streams } = setup()
      await conversations.send(key, "Do this instead", { along: true, setAside: ["r1"] })
      expect(streams.prompt).toHaveBeenCalledWith("t", "Do this instead", {
        along: true,
        setAside: ["r1"],
      })
      await conversations.interrupt(key, { setAside: ["r1"] })
      expect(streams.interrupt).toHaveBeenCalledWith("t", { setAside: ["r1"] })
    })

    it("sends the person to the terminal where setting a question aside went wrong", async () => {
      const { conversations, streams } = setup()
      const failed = new WireError("ANSWER_FAILED", "The dialog didn't go.", {
        data: { returned: "my words" },
      })
      streams.prompt.mockRejectedValue(failed)
      await expect(conversations.send(key, "my words", { setAside: ["q1"] })).rejects.toThrow(
        "The question couldn't be set aside. Answer it in the terminal, then send again.",
      )
      streams.interrupt.mockRejectedValue(new WireError("DIALOG_CHANGED", "It changed."))
      await expect(conversations.interrupt(key, { setAside: ["q1"] })).rejects.toThrow(
        "The question couldn't be set aside. Answer it in the terminal, then stop it again.",
      )
    })

    it("says a question taking only words can't be set aside by images", async () => {
      const { conversations, streams } = setup()
      streams.prompt.mockRejectedValue(
        new WireError("CONFLICT", "The question takes words only.", {
          data: { reason: "question-words-only" },
        }),
      )
      await expect(conversations.send(key, "see this", { setAside: ["r1"] })).rejects.toThrow(
        "The agent's question takes only words in its answer. Remove the images, or answer it first.",
      )
    })

    it("still says to answer a permission first, which a Send or Stop over it never sets aside", async () => {
      const { conversations, streams } = setup()
      const pending = new WireError("CONFLICT", "A request waits.", { data: { reason: "pending" } })
      streams.prompt.mockRejectedValue(pending)
      await expect(conversations.send(key, "hi", { setAside: ["r1"] })).rejects.toThrow(
        "The agent is waiting for your answer. Answer it here, then send again.",
      )
      streams.interrupt.mockRejectedValue(pending)
      await expect(conversations.interrupt(key, { setAside: ["r1"] })).rejects.toThrow(
        "The agent is waiting for your answer. Answer it first, then stop it.",
      )
    })

    it("saves a pasted image on the runner and sends its path with the prompt", async () => {
      const { conversations, streams } = setup()
      const file = { name: "shot.png", data: new Uint8Array([1]) }
      await expect(conversations.uploadImage?.(key, file)).resolves.toBe("/runner/shot.png")
      expect(streams.upload).toHaveBeenCalledWith("t", file)
      await conversations.send(key, "", { ref: "r", images: ["/runner/shot.png"] })
      expect(streams.prompt).toHaveBeenCalledWith("t", "", {
        ref: "r",
        images: ["/runner/shot.png"],
      })
    })

    it("sends where each image goes among the words, and gives back where they stood", async () => {
      const { conversations, streams } = setup()
      await conversations.send(key, "See this:  and fix it", {
        ref: "r",
        images: ["/runner/shot.png"],
        at: [10],
      })
      expect(streams.prompt).toHaveBeenCalledWith("t", "See this:  and fix it", {
        ref: "r",
        images: ["/runner/shot.png"],
        at: [10],
      })
      streams.interrupt.mockResolvedValueOnce({
        returned: "a b",
        images: ["/runner/a.png"],
        at: [2],
      })
      expect(await conversations.interrupt(key)).toEqual({
        words: "a b",
        images: ["/runner/a.png"],
        at: [2],
      })
      streams.takeBox.mockResolvedValueOnce({
        returned: "a b",
        images: ["/runner/a.png"],
        at: [1],
      })
      await expect(conversations.takeBox?.(key)).resolves.toEqual({
        words: "a b",
        images: ["/runner/a.png"],
        at: [1],
      })
    })

    it("says an image couldn't go when the runner refuses one, and that the agent didn't take it", async () => {
      const { conversations, streams } = setup()
      streams.prompt.mockRejectedValueOnce(
        new WireError("PROMPT_REFUSED", "An image of the prompt is gone."),
      )
      await expect(conversations.send(key, "", { images: ["/runner/a.png"] })).rejects.toThrow(
        "An image couldn't go. Remove it and paste it again.",
      )
      // Without images, a refusal is the text's own.
      streams.prompt.mockRejectedValueOnce(new WireError("PROMPT_REFUSED", "Nope."))
      await expect(conversations.send(key, "hi")).rejects.toThrow("Nope.")
      streams.prompt.mockRejectedValueOnce(
        new WireError("PROMPT_FAILED", "Any message: the reason is in the data.", {
          data: { returned: "words", reason: "image-not-shown" },
        }),
      )
      await expect(
        conversations.send(key, "hi", { images: ["/runner/a.png"] }),
      ).rejects.toMatchObject({
        message: "The agent didn't take the image. It is back in the box.",
        returned: "words",
      })
    })

    it("tells the person why an image didn't upload", async () => {
      const { conversations, streams } = setup()
      streams.upload.mockRejectedValueOnce(new WireError("UPLOAD_TOO_LARGE"))
      await expect(
        conversations.uploadImage?.(key, { name: "a.png", data: new Uint8Array() }),
      ).rejects.toThrow("over the size")
      streams.upload.mockRejectedValueOnce(new WireError("DISCONNECTED"))
      await expect(
        conversations.uploadImage?.(key, { name: "a.png", data: new Uint8Array() }),
      ).rejects.toThrow("offline")
    })

    it("marks a fixed line an Inbox button sends as automatic", async () => {
      const { conversations, streams } = setup()
      await conversations.send(key, "continue", { automatic: true })
      expect(streams.prompt).toHaveBeenCalledWith("t", "continue", { automatic: true })
    })

    it("names the prompt's receipt with the ref given", async () => {
      const { conversations, streams } = setup()
      await conversations.send(key, "hello", { ref: "abcdefghijklmnop" })
      expect(streams.prompt).toHaveBeenCalledWith("t", "hello", { ref: "abcdefghijklmnop" })
    })

    it("empties the conversation once its terminal is gone, so what waited on it hears so", async () => {
      const { details, store } = setup()
      const unsubscribe = store.subscribe(() => {})
      const receipt = {
        ref: "abcdefghijklmnop",
        text: "hello",
        sentAt: 1,
        state: "pending" as const,
        item: null,
      }
      details.push(detail({ prompts: [receipt] }))
      await vi.waitFor(() => expect(store.getSnapshot().prompts).toEqual([receipt]))
      details.end()
      await vi.waitFor(() => expect(store.getSnapshot()).toEqual(noConversation))
      unsubscribe()
    })

    it("keeps a settled prompt's words, which its receipt no longer carries", async () => {
      const { details, store } = setup()
      const unsubscribe = store.subscribe(() => {})
      const receipt = {
        ref: "abcdefghijklmnop",
        text: "hello",
        sentAt: 1,
        state: "pending" as const,
        item: null,
      }
      details.push(detail({ prompts: [receipt] }))
      await vi.waitFor(() => expect(store.getSnapshot().prompts).toEqual([receipt]))
      details.push(detail({ prompts: [{ ...receipt, state: "settled", text: null, item: 3 }] }))
      await vi.waitFor(() =>
        expect(store.getSnapshot().prompts).toEqual([{ ...receipt, state: "settled", item: 3 }]),
      )
      unsubscribe()
    })

    it("shows no prompts from a runner that sends no receipts", async () => {
      const { details, store } = setup()
      const unsubscribe = store.subscribe(() => {})
      const { prompts: _none, ...older } = detail()
      details.push(older)
      await vi.waitFor(() => expect(store.getSnapshot().session).toBe("s1"))
      expect(store.getSnapshot().prompts).toEqual([])
      unsubscribe()
    })

    it("shows the session's receipts as its prompts", async () => {
      const { details, store } = setup()
      const unsubscribe = store.subscribe(() => {})
      const receipt = {
        ref: "abcdefghijklmnop",
        text: "hello",
        sentAt: 1,
        state: "unrecorded" as const,
        item: null,
      }
      details.push(detail({ prompts: [receipt] }))
      await vi.waitFor(() => expect(store.getSnapshot().prompts).toEqual([receipt]))
      unsubscribe()
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
      streams.prompt.mockRejectedValue(new WireError(code))
      await expect(conversations.send(key, "hi")).rejects.toThrow(message)
    })

    it("words a conflict by the reason the runner gives, offering the terminal where it settles there", async () => {
      const { conversations, streams } = setup()
      const failing = async (data: unknown): Promise<unknown> => {
        streams.prompt.mockRejectedValueOnce(
          new WireError("CONFLICT", "The runner's own words", { data }),
        )
        return conversations.send(key, "hi").catch((failure: unknown) => failure)
      }
      // The chat clears the box itself: none of these sends the person to the terminal.
      for (const [reason, words] of [
        ["draft", "already holds text"],
        ["shell", "shell mode"],
        ["command", "a command it hasn't run"],
      ] as const) {
        // eslint-disable-next-line no-await-in-loop -- Each arms the next send's failure.
        const box = await failing({ reason })
        expect(box).not.toBeInstanceOf(SettleInTerminal)
        expect(box).toHaveProperty("message", expect.stringContaining(words))
        expect(box).toHaveProperty("message", expect.stringContaining("Clear it above"))
      }
      const ringing = await failing({ reason: "ringing" })
      expect(ringing).not.toBeInstanceOf(SettleInTerminal)
      expect(ringing).toBeInstanceOf(RingUnderWay)
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
        new WireError("PROMPT_REFUSED", "A message can't hold control characters."),
      )
      await expect(conversations.send(key, "hi")).rejects.toThrow("control characters")
      streams.prompt.mockRejectedValue(new WireError("PROMPT_REFUSED"))
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
      expect(await conversations.interrupt(key)).toEqual({ words: null })
      streams.interrupt.mockResolvedValueOnce({
        returned: "Queued beta",
        images: ["/runner/a.png"],
      })
      expect(await conversations.interrupt(key)).toEqual({
        words: "Queued beta",
        images: ["/runner/a.png"],
      })
      streams.interrupt.mockRejectedValueOnce(new WireError("BOX_NOT_CLEARED"))
      await expect(conversations.interrupt(key)).rejects.toThrow("still in the agent's box")
    })

    it("tells the person why an interrupt didn't go", async () => {
      const { conversations, streams } = setup()
      streams.interrupt.mockRejectedValue(
        new WireError("CONFLICT", "No agent is running in this terminal.", {
          data: { reason: "no-box" },
        }),
      )
      await expect(conversations.interrupt(key)).rejects.toThrow("can't find the agent's input box")
      streams.interrupt.mockRejectedValue(
        new WireError("CONFLICT", "A request waits.", { data: { reason: "pending" } }),
      )
      await expect(conversations.interrupt(key)).rejects.toThrow("Answer it first, then stop it")
      streams.interrupt.mockRejectedValue(
        new WireError("CONFLICT", "Ringing.", { data: { reason: "ringing" } }),
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
      streams.answer.mockRejectedValue(new WireError("WORDS_NOT_SENT"))
      await expect(
        conversations.answer(key, "r", { type: "chat", dialog: "q1", text: "why" }),
      ).rejects.toBeInstanceOf(WordsLost)
    })

    it("tells an answer that took but whose words didn't from one that didn't take", async () => {
      const { conversations, streams } = setup()
      streams.answer.mockRejectedValue(
        new WireError(
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
        new WireError("CONFLICT", "A message's doorbell is ringing the agent.", {
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
      streams.answer.mockRejectedValue(new WireError(code))
      await expect(
        conversations.answer(key, "r", { type: "choice", dialog: "d1", option: "1" }),
      ).rejects.toThrow(message)
    })
  })
})
