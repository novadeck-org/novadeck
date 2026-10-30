import type { ChatDialog } from "@novadeck/core/conversation"
import type { InboxBinding } from "@novadeck/core/inbox"
import { dialogMs, type Asked } from "@novadeck/core/inbox/rows"
import {
  noMessages,
  type AgentMessage,
  type MessageParty,
  type MessagesState,
  type MessageThread,
} from "@novadeck/core/messages"
import { createTerminalState } from "@novadeck/core/state"
import { createStore } from "@novadeck/core/store"
import type { AgentStatus, AgentTurnEnd, TerminalMetadata, Workspace } from "@novadeck/core/types"
import { longHoldMs, type AgentDetail, type InboxEntry } from "@novadeck/protocol"
import { afterEach, beforeEach, vi } from "vitest"

import { createRunnerInbox, detailGraceMs, retryMs, settleMs, type InboxStreams } from "./inbox"
import { describe, expect, it } from "./test"

const agentParty = (handle: string): MessageParty => ({ kind: "agent", handle, agent: null })

const choices: ChatDialog = {
  type: "choices",
  id: "d1",
  title: null,
  detail: "pnpm add x",
  options: [{ id: "yes", label: "Yes", text: null }],
}

const agentTerminal = (
  number: number,
  agent: AgentStatus = { working: false },
  process = "claude",
): TerminalMetadata => ({
  id: `0${number}`,
  name: `Terminal ${number}`,
  directory: "/work/app",
  command: process,
  process,
  handle: ["moth", "fox", "owl", "crow"][number - 1]!,
  state: "running",
  agent,
})

const workspaceOf = (...terminals: TerminalMetadata[]): Workspace => ({
  activeProjectId: "p",
  projects: [
    {
      id: "p",
      name: "App",
      directory: "/work/app",
      activeSessionId: "s",
      history: [
        {
          id: "s",
          name: "s",
          visitedAt: 0,
          state: createTerminalState(terminals, "grid", "grid"),
        },
      ],
    },
  ],
})

const turn = (end: Partial<AgentTurnEnd> = {}): AgentTurnEnd => ({
  outcome: "completed",
  at: 100,
  ...end,
})

const asked = (id: string, askedAt: number, dialog: ChatDialog | null = choices): Asked => ({
  request: {
    id,
    kind: "permission",
    tool: "Bash",
    subject: "pnpm add x",
    choices: [],
    subagent: false,
    dialog,
    answered: false,
  },
  askedAt,
})

const message = (change: Partial<AgentMessage> = {}): AgentMessage => ({
  id: "m1",
  hop: 3,
  from: agentParty("moth"),
  to: agentParty("fox"),
  text: "Is the schema ready?",
  sentAt: 50,
  state: "held",
  held: "release",
  deliveredAt: null,
  ...change,
})

const thread = (change: Partial<MessageThread> = {}): MessageThread => ({
  id: "th1",
  peer: agentParty("fox"),
  hops: 3,
  idle: 0,
  held: true,
  heldFor: "loop",
  messages: [message()],
  ...change,
})

const messagesOf = (...threads: MessageThread[]): MessagesState => ({
  ...noMessages,
  terminals: { "p/s/01": { handle: "moth", agent: true, threads } },
})

// The finished turns the tests state, by session context then terminal: each stands for the
// stored row of that terminal's current end, as the runner lists it.
type Marks = Readonly<Record<string, Readonly<Record<string, "done" | "failed">>>>
const done: Marks = { "p/s": { "01": "done" } }
const failed: Marks = { "p/s": { "01": "failed" } }

const turnEntriesOf = (workspace: Workspace, marks: Marks): InboxEntry[] =>
  workspace.projects.flatMap((project) =>
    project.history.flatMap((session) =>
      session.state.roster.terminals.flatMap((terminal): InboxEntry[] => {
        const mark = marks[`${project.id}/${session.id}`]?.[terminal.id]
        const end = terminal.state === "running" ? terminal.agent?.lastTurn : undefined
        if (!mark || !end) return []
        return [
          {
            id: `${mark === "done" ? "update" : "trouble"}:${terminal.id}:${end.at}`,
            terminalId: terminal.id,
            projectId: project.id,
            workspaceSessionId: session.id,
            agent: "claude",
            sessionId: "harness-session",
            handle: terminal.handle ?? "",
            at: end.at,
            content: {
              kind: "turn",
              outcome: mark === "done" ? "completed" : "failed",
              reply: end.reply ?? null,
              error: end.error ?? null,
              files: [...(end.files ?? [])],
            },
          },
        ]
      }),
    ),
  )

// A stream the test pushes into.
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

const detailOf = (...requests: Asked[]): AgentDetail => ({
  terminalId: "01",
  agent: "claude",
  sessionId: "s1",
  activity: null,
  telemetry: null,
  actors: [{ ref: "rootrootrootroot", role: "root", parent: null, type: null }],
  requests: requests.map(({ request, askedAt }) => ({
    ref: request.id,
    actor: "rootrootrootroot",
    kind: request.kind,
    tool: request.tool,
    subject: request.subject,
    choices: [...request.choices],
    dialog: request.dialog as AgentDetail["requests"][number]["dialog"],
    answered: request.answered,
    askedAt,
  })),
  coverage: null,
})

const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => vi.useFakeTimers({ now: 10_000 }))
afterEach(() => vi.useRealTimers())

const setup = (workspace: Workspace, unread: Marks = {}, messages: MessagesState = noMessages) => {
  const details: ReturnType<typeof pushed<AgentDetail>>[] = []
  const feed = pushed<InboxEntry[]>()
  // What the runner lists: the asks and tells a test pushes, and the turn rows its marks
  // stand for, which reading removes.
  let others: InboxEntry[] = []
  let rows: InboxEntry[] = []
  const publish = () => feed.push([...others, ...rows])
  const entries = {
    stream: feed.stream,
    returned: feed.returned,
    push: (list: InboxEntry[]) => {
      others = list
      publish()
    },
  }
  const streams = {
    inbox: {
      watch: vi.fn<InboxStreams["inbox"]["watch"]>(() => feed.stream),
      answer: vi.fn<InboxStreams["inbox"]["answer"]>(async () => {}),
      dismiss: vi.fn<InboxStreams["inbox"]["dismiss"]>(async () => {}),
      clear: vi.fn<InboxStreams["inbox"]["clear"]>(async () => {}),
      read: vi.fn<InboxStreams["inbox"]["read"]>(async (ids) => {
        const gone = ({ id, content }: InboxEntry) => content.kind === "turn" && ids.includes(id)
        if (!rows.some(gone) && !others.some(gone)) return
        rows = rows.filter((each) => !gone(each))
        others = others.filter((each) => !gone(each))
        publish()
      }),
    },
    detail: vi.fn<InboxStreams["detail"]>(() => {
      const next = pushed<AgentDetail>()
      details.push(next)
      return next.stream
    }),
    answer: vi.fn<InboxStreams["answer"]>(async () => {}),
    send: vi.fn<InboxStreams["send"]>(async () => {}),
    interrupt: vi.fn<InboxStreams["interrupt"]>(async () => null),
    release: vi.fn<InboxStreams["release"]>(),
    stop: vi.fn<InboxStreams["stop"]>(),
  }
  const workspaceStore = createStore(workspace)
  const messagesStore = createStore(messages)
  // The runner now lists these marks' rows.
  const marks = (next: Marks): void => {
    rows = turnEntriesOf(workspaceStore.getSnapshot(), next)
    publish()
  }
  // The messages track a release or a stop in the messages state, as the runner backend's do.
  const releasing = (id: string) =>
    messagesStore.update((current) => ({
      ...current,
      releasing: { ...current.releasing, [id]: "asked" },
    }))
  streams.release.mockImplementation(releasing)
  streams.stop.mockImplementation(releasing)
  const inbox = createRunnerInbox(streams, messagesStore)
  const binding: InboxBinding = { workspace: workspaceStore }
  if (Object.keys(unread).length > 0) marks(unread)
  const stop = inbox.bind(binding)
  const ids = () => inbox.state.getSnapshot().items.map((item) => item.id)
  return {
    inbox,
    streams,
    details,
    entries,
    workspaceStore,
    marks,
    messagesStore,
    stop,
    ids,
  }
}

const attention: AgentStatus = { working: true, attention: { kind: "permission", count: 1 } }

describe("The runner's Inbox", () => {
  describe("binding", () => {
    it("shows what the app's state holds, and empties when it stops", async () => {
      const { inbox, stop, ids } = setup(
        workspaceOf(agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed" }) })),
        failed,
      )
      await settle()
      expect(ids()).toEqual(["trouble:01:100"])

      stop()

      expect(inbox.state.getSnapshot()).toEqual({ items: [], answering: {}, failed: {} })
    })

    it("follows the stored failed turns and the messages, and shows no completed one", async () => {
      const pair = workspaceOf(
        agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed" }) }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const { marks, messagesStore, ids } = setup(pair)
      expect(ids()).toEqual([])

      marks(done)
      await settle()
      expect(ids()).toEqual([])

      marks(failed)
      await settle()
      expect(ids()).toEqual(["trouble:01:100"])

      messagesStore.update(() => messagesOf(thread()))
      expect(ids().toSorted()).toEqual(["held:th1", "trouble:01:100"])
      messagesStore.update(() => messagesOf(thread({ held: false })))
      expect(ids()).toEqual(["trouble:01:100"])
    })

    it("keeps an item's object while it reads the same", async () => {
      const { inbox, marks } = setup(
        workspaceOf(
          agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed" }) }),
          agentTerminal(2, { working: false, lastTurn: turn({ outcome: "failed", at: 7 }) }),
        ),
        { "p/s": { "01": "failed" } },
      )
      await settle()
      const [before] = inbox.state.getSnapshot().items
      marks({ "p/s": { "01": "failed", "02": "failed" } })
      await settle()

      expect(inbox.state.getSnapshot().items.find((item) => item.id === before!.id)).toBe(before)
    })
  })

  describe("reading requests", () => {
    const waiting = () => workspaceOf(agentTerminal(1, attention))

    it("opens a terminal's detail only while its agent waits on a request", async () => {
      const { streams } = setup(workspaceOf(agentTerminal(1), agentTerminal(2, attention)))

      expect(streams.detail).toHaveBeenCalledTimes(1)
      expect(streams.detail).toHaveBeenCalledWith("02")
    })

    it("shows the request once its detail arrives", async () => {
      const { details, ids } = setup(waiting())
      details[0]!.push(detailOf(asked("r1", 9000)))
      await settle()

      expect(ids()).toEqual(["request:r1"])
    })

    it("shows a request without a dialog after a moment, to answer in the terminal", async () => {
      const { details, inbox, ids } = setup(waiting())
      details[0]!.push(detailOf(asked("r1", 10_000, null)))
      await settle()
      expect(ids()).toEqual([])

      await vi.advanceTimersByTimeAsync(dialogMs)

      expect(ids()).toEqual(["request:r1"])
      expect(inbox.state.getSnapshot().items[0]).toMatchObject({ request: { dialog: null } })
    })

    it("shows messages held behind an idle agent's box once the hold has lasted", async () => {
      const pair = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, { working: false }, "agy"),
      )
      const messages: MessagesState = {
        ...noMessages,
        terminals: {
          "p/s/02": {
            handle: "fox",
            agent: true,
            waits: "draft",
            waitsSince: 10_000,
            threads: [
              thread({
                peer: agentParty("moth"),
                held: false,
                messages: [message({ state: "queued", held: null })],
              }),
            ],
          },
        },
      }
      const { ids } = setup(pair, {}, messages)
      await settle()
      expect(ids()).toEqual([])

      await vi.advanceTimersByTimeAsync(longHoldMs)

      expect(ids()).toEqual(["waits:02:10000"])
    })

    it("closes the detail a while after nothing waits, and not before", async () => {
      const { details, workspaceStore } = setup(waiting())
      const rested = workspaceOf(agentTerminal(1))
      workspaceStore.update(() => rested)

      await vi.advanceTimersByTimeAsync(detailGraceMs - 1)
      expect(details[0]!.returned).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(details[0]!.returned).toHaveBeenCalledTimes(1)
    })

    it("keeps the detail open when a request comes within the grace", async () => {
      const { streams, details, workspaceStore } = setup(waiting())
      workspaceStore.update(() => workspaceOf(agentTerminal(1)))
      await vi.advanceTimersByTimeAsync(detailGraceMs - 1000)
      workspaceStore.update(() => waiting())
      await vi.advanceTimersByTimeAsync(detailGraceMs * 2)

      expect(streams.detail).toHaveBeenCalledTimes(1)
      expect(details[0]!.returned).not.toHaveBeenCalled()
    })

    it("opens a lost detail again while the agent still waits, backing off", async () => {
      const { streams, details, ids } = setup(waiting())
      details[0]!.fail(new Error("lost"))
      await settle()
      expect(streams.detail).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(retryMs)
      expect(streams.detail).toHaveBeenCalledTimes(2)
      details[1]!.push(detailOf(asked("r1", 9000)))
      await settle()
      expect(ids()).toEqual(["request:r1"])

      details[1]!.finish()
      await settle()
      await vi.advanceTimersByTimeAsync(retryMs)
      expect(streams.detail).toHaveBeenCalledTimes(3)
    })

    it("opens nothing once the backend has stopped", async () => {
      const { inbox, streams, workspaceStore, details } = setup(waiting())
      inbox.end()
      workspaceStore.update(() => workspaceOf(agentTerminal(1), agentTerminal(2, attention)))
      await vi.advanceTimersByTimeAsync(detailGraceMs)

      expect(streams.detail).toHaveBeenCalledTimes(1)
      expect(details[0]!.returned).toHaveBeenCalled()
    })

    it("stops reading once unbound", async () => {
      const { details, stop, streams } = setup(waiting())
      stop()
      await settle()
      await vi.advanceTimersByTimeAsync(detailGraceMs * 3)

      expect(details[0]!.returned).toHaveBeenCalledTimes(1)
      expect(streams.detail).toHaveBeenCalledTimes(1)
    })

    it("marks a request answered from the app as answering", async () => {
      const { details, inbox } = setup(waiting())
      const answeredRequest = asked("r1", 9000)
      details[0]!.push(
        detailOf({ ...answeredRequest, request: { ...answeredRequest.request, answered: true } }),
      )
      await settle()

      expect(inbox.state.getSnapshot().answering).toEqual({ "request:r1": true })
    })
  })

  describe("answering", () => {
    const waiting = () => workspaceOf(agentTerminal(1, attention))
    const withRequest = async () => {
      const set = setup(waiting())
      set.details[0]!.push(detailOf(asked("r1", 9000)))
      await settle()
      return set
    }

    it("answers a request through its dialog, and marks it answering until it goes", async () => {
      const { inbox, streams, workspaceStore, ids } = await withRequest()
      const answer = { type: "choice", dialog: "d1", option: "yes" } as const
      inbox.answer("request:r1", { kind: "request", answer })

      expect(streams.answer).toHaveBeenCalledWith(
        { projectId: "p", workspaceSessionId: "s", terminalId: "01" },
        "r1",
        answer,
      )
      expect(inbox.state.getSnapshot().answering).toEqual({ "request:r1": true })

      workspaceStore.update(() => workspaceOf(agentTerminal(1)))
      expect(ids()).toEqual([])
      await settle()
      expect(inbox.state.getSnapshot().answering).toEqual({})
    })

    it("answers once while the answer is on its way", async () => {
      const { inbox, streams } = await withRequest()
      const answer = { type: "choice", dialog: "d1", option: "yes" } as const
      inbox.answer("request:r1", { kind: "request", answer })
      inbox.answer("request:r1", { kind: "request", answer })

      expect(streams.answer).toHaveBeenCalledTimes(1)
    })

    it("says why an answer didn't take and lets it be answered again", async () => {
      const { inbox, streams } = await withRequest()
      streams.answer.mockRejectedValueOnce(
        new Error("The dialog changed — check it and answer again."),
      )
      const answer = { type: "choice", dialog: "d1", option: "yes" } as const
      inbox.answer("request:r1", { kind: "request", answer })
      await settle()

      expect(inbox.state.getSnapshot().answering).toEqual({})
      expect(inbox.state.getSnapshot().failed).toEqual({
        "request:r1": "The dialog changed — check it and answer again.",
      })

      inbox.answer("request:r1", { kind: "request", answer })
      expect(inbox.state.getSnapshot().failed).toEqual({})
      expect(inbox.state.getSnapshot().answering).toEqual({ "request:r1": true })
    })

    it("refuses an answer made for another kind of item", async () => {
      const { inbox, streams } = await withRequest()
      inbox.answer("request:r1", { kind: "update", action: "read" })

      expect(streams.answer).not.toHaveBeenCalled()
      expect(inbox.state.getSnapshot().failed["request:r1"]).toBe(
        "That answer isn't for this item.",
      )
    })

    it("releases and stops a held thread, and drops it once the listing shows it going on", async () => {
      const pair = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const { inbox, streams, messagesStore, ids } = setup(pair, {}, messagesOf(thread()))
      inbox.answer("held:th1", { kind: "held", action: "release" })
      expect(streams.release).toHaveBeenCalledWith("th1")
      expect(inbox.state.getSnapshot().answering).toEqual({ "held:th1": true })

      messagesStore.update(() => messagesOf(thread({ held: false })))
      expect(ids()).toEqual([])
      expect(inbox.state.getSnapshot().answering).toEqual({})

      messagesStore.update(() => ({ ...messagesOf(thread({ id: "th2" })), releasing: {} }))
      inbox.answer("held:th2", { kind: "held", action: "stop" })
      expect(streams.stop).toHaveBeenCalledWith("th2")
    })

    it("says why the messages couldn't release a thread, and answers as the pane's release does", () => {
      const pair = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const { inbox, messagesStore } = setup(pair, {}, messagesOf(thread()))
      messagesStore.update((current) => ({ ...current, releasing: { th1: "asked" } }))
      expect(inbox.state.getSnapshot().answering).toEqual({ "held:th1": true })

      messagesStore.update((current) => ({
        ...current,
        releasing: {},
        failed: { th1: "Couldn't release it: lost" },
      }))
      expect(inbox.state.getSnapshot().answering).toEqual({})
      expect(inbox.state.getSnapshot().failed).toEqual({ "held:th1": "Couldn't release it: lost" })
    })
  })

  describe("updates", () => {
    const report = (id: string, change: Partial<InboxEntry> = {}): InboxEntry =>
      entry({
        id,
        content: { kind: "done", subject: `Report ${id}`, body: "All of it." },
        ...change,
      })
    const two = () => workspaceOf(agentTerminal(1), agentTerminal(2, { working: false }, "codex"))
    const fox = { terminalId: "02", handle: "fox", agent: "codex" as const }

    it("reads a done report by its id, which the runner drops", async () => {
      const { inbox, streams, entries, ids } = setup(two())
      entries.push([report("done-1"), report("done-2", fox)])
      await settle()
      expect(ids().toSorted()).toEqual(["done-1", "done-2"])
      inbox.answer("done-1", { kind: "update", action: "read" })
      expect(inbox.state.getSnapshot().answering).toEqual({ "done-1": true })
      await settle()

      expect(streams.inbox.read).toHaveBeenCalledExactlyOnceWith(["done-1"])
      entries.push([report("done-2", fox)])
      await settle()
      expect(ids()).toEqual(["done-2"])
      expect(inbox.state.getSnapshot().answering).toEqual({})
    })

    it("reads a failed row by its id, current or not", async () => {
      const ws = workspaceOf(
        agentTerminal(1, {
          working: false,
          lastTurn: turn({ outcome: "failed", at: 200, error: "x" }),
        }),
      )
      const { inbox, streams, entries, marks, ids } = setup(ws, { "p/s": { "01": "failed" } })
      await settle()
      const older = {
        ...turnEntriesOf(ws, { "p/s": { "01": "failed" } })[0]!,
        id: "old-row",
        at: 50,
      }
      entries.push([older])
      await settle()
      expect(ids().toSorted()).toEqual(["old-row", "trouble:01:200"])

      inbox.answer("old-row", { kind: "trouble", action: { type: "read" } })
      inbox.answer("trouble:01:200", { kind: "trouble", action: { type: "read" } })
      await settle()

      expect(streams.inbox.read.mock.calls.map(([batch]) => batch)).toEqual([
        ["old-row"],
        ["trouble:01:200"],
      ])
      void marks
    })

    it("reads every update and failed row that only informs, leaving what waits on the person", async () => {
      const waiting = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, {
          working: false,
          lastTurn: turn({ outcome: "failed", at: 200, error: "x" }),
        }),
      )
      const { inbox, streams, entries, ids } = setup(waiting, { "p/s": { "02": "failed" } })
      await settle()
      entries.push([
        report("done-1"),
        told("told-1"),
        {
          ...turnEntriesOf(waiting, { "p/s": { "02": "failed" } })[0]!,
          id: "old-row",
          at: 50,
        },
      ])
      await settle()
      inbox.readAll()
      await settle()

      expect(streams.inbox.read).toHaveBeenCalledOnce()
      expect(streams.inbox.read.mock.calls[0]![0].toSorted()).toEqual([
        "done-1",
        "old-row",
        "told-1",
      ])
      // What was submitted stays, answering, until the runner drops it; what waits stays too.
      expect(ids().toSorted()).toEqual(["done-1", "told-1", "trouble:02:200"])
      expect(Object.keys(inbox.state.getSnapshot().answering).toSorted()).toEqual([
        "done-1",
        "told-1",
      ])
    })

    it("marks an item seen, here only, until it goes", async () => {
      const { inbox, entries } = setup(two())
      entries.push([report("done-1"), report("done-2", fox)])
      await settle()
      inbox.see("done-1")
      const seen = () =>
        inbox.state
          .getSnapshot()
          .items.toSorted((a, b) => a.id.localeCompare(b.id))
          .map((item) => item.seen)
      expect(seen()).toEqual([true, false])

      entries.push([report("done-2", fox)])
      await settle()
      entries.push([report("done-1"), report("done-2", fox)])
      await settle()
      expect(seen()).toEqual([false, false])
    })
  })

  describe("trouble", () => {
    const limitHit = () =>
      workspaceOf(
        agentTerminal(1, {
          working: false,
          lastTurn: turn({ outcome: "failed", limit: { minutes: 300, resetsAt: 5000 } }),
        }),
      )
    const key = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }

    it("continues a limit with a plain prompt and no interrupt", () => {
      const { inbox, streams } = setup(limitHit())
      inbox.answer("limit:01:100", { kind: "trouble", action: { type: "continue" } })

      expect(streams.send).toHaveBeenCalledWith(key, "continue", { automatic: true })
      expect(streams.interrupt).not.toHaveBeenCalled()
    })

    it("shows why a continue was refused and keeps the limit", async () => {
      const { inbox, streams, ids } = setup(limitHit())
      streams.send.mockRejectedValueOnce(new Error("There's a draft in its box."))
      inbox.answer("limit:01:100", { kind: "trouble", action: { type: "continue" } })
      await settle()

      expect(inbox.state.getSnapshot().failed).toEqual({
        "limit:01:100": "There's a draft in its box.",
      })
      expect(ids()).toEqual(["limit:01:100"])
    })

    it("nudges an idle agent by sending only", async () => {
      const { inbox, streams } = setup(
        workspaceOf(
          agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed", error: "x" }) }),
        ),
        failed,
      )
      await settle()
      inbox.answer("trouble:01:100", {
        kind: "trouble",
        action: { type: "nudge", text: "Fix it." },
      })
      await settle()

      expect(streams.interrupt).not.toHaveBeenCalled()
      expect(streams.send).toHaveBeenCalledWith(key, "Fix it.", { automatic: true })
    })

    it("reads the failed row once its nudge was sent, with nothing left answering", async () => {
      const { inbox, streams, ids } = setup(
        workspaceOf(
          agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed", error: "x" }) }),
        ),
        failed,
      )
      await settle()
      inbox.answer("trouble:01:100", { kind: "trouble", action: { type: "nudge", text: "go" } })
      await settle()

      expect(streams.inbox.read).toHaveBeenCalledExactlyOnceWith(["trouble:01:100"])
      expect(ids()).toEqual([])
      expect(inbox.state.getSnapshot().answering).toEqual({})
    })

    it("nudges no failed row while its agent works, and interrupts nothing", async () => {
      const working = agentTerminal(1, {
        working: true,
        lastTurn: turn({ outcome: "failed", error: "x" }),
      })
      const { inbox, streams } = setup(workspaceOf(working), failed)
      await settle()
      inbox.answer("trouble:01:100", { kind: "trouble", action: { type: "nudge", text: "go" } })
      await settle()

      expect(streams.interrupt).not.toHaveBeenCalled()
      expect(streams.send).not.toHaveBeenCalled()
      expect(inbox.state.getSnapshot().answering).toEqual({})
    })

    it("gives the buttons back when a continue started no turn", async () => {
      const { inbox } = setup(limitHit())
      inbox.answer("limit:01:100", { kind: "trouble", action: { type: "continue" } })
      await settle()
      expect(inbox.state.getSnapshot().answering).toEqual({ "limit:01:100": true })

      await vi.advanceTimersByTimeAsync(settleMs)

      expect(inbox.state.getSnapshot().answering).toEqual({})
      expect(inbox.state.getSnapshot().items.map((item) => item.id)).toEqual(["limit:01:100"])
    })

    it("waits long enough for a slow harness to start its turn", async () => {
      const { inbox } = setup(limitHit())
      inbox.answer("limit:01:100", { kind: "trouble", action: { type: "continue" } })
      await vi.advanceTimersByTimeAsync(settleMs - 1)

      expect(inbox.state.getSnapshot().answering).toEqual({ "limit:01:100": true })
    })

    it("lets a newer answer's wait run its own course, not an older one's", async () => {
      const { inbox, workspaceStore } = setup(limitHit())
      inbox.answer("limit:01:100", { kind: "trouble", action: { type: "continue" } })
      await settle()
      // The item goes and comes back with the same id, and is answered again.
      workspaceStore.update(() => workspaceOf(agentTerminal(1)))
      await vi.advanceTimersByTimeAsync(settleMs - 1000)
      workspaceStore.update(() => limitHit())
      inbox.answer("limit:01:100", { kind: "trouble", action: { type: "continue" } })
      await vi.advanceTimersByTimeAsync(1000)

      // The first answer's wait is over; the second's is not.
      expect(inbox.state.getSnapshot().answering).toEqual({ "limit:01:100": true })
      await vi.advanceTimersByTimeAsync(settleMs - 1000)
      expect(inbox.state.getSnapshot().answering).toEqual({})
    })

    it("drops its waits once unbound or ended", async () => {
      const { inbox, stop } = setup(limitHit())
      inbox.answer("limit:01:100", { kind: "trouble", action: { type: "continue" } })
      await settle()
      stop()

      expect(vi.getTimerCount()).toBe(0)
      inbox.end()
    })

    it("stops an agent by interrupting it", () => {
      const { inbox, streams } = setup(limitHit())
      inbox.answer("limit:01:100", { kind: "trouble", action: { type: "stop" } })

      expect(streams.interrupt).toHaveBeenCalledWith(key)
    })

    it("has no auto-resume to turn on or off", () => {
      const { inbox, streams } = setup(limitHit())
      inbox.answer("limit:01:100", {
        kind: "trouble",
        action: { type: "auto-resume", on: true },
      })

      expect(streams.send).not.toHaveBeenCalled()
      expect(inbox.state.getSnapshot().answering).toEqual({})
    })
  })
})

const entry = (change: Partial<InboxEntry> = {}): InboxEntry => ({
  id: "entry-1",
  terminalId: "01",
  projectId: "p",
  workspaceSessionId: "s",
  agent: "claude",
  sessionId: "harness-session",
  handle: "moth",
  at: 4000,
  content: {
    kind: "ask",
    ask: {
      subject: "Which route?",
      body: "Choose a route.",
      details: null,
      hardToUndo: null,
      shape: { type: "text" },
    },
  },
  ...change,
})

const told = (id = "told-1"): InboxEntry =>
  entry({ id, content: { kind: "tell", subject: "Preview ready", body: "Open the preview." } })

describe("Inbox entries", () => {
  it("follows one global stream while bound and closes it when unbound", async () => {
    const { inbox, streams, entries, stop, ids } = setup(workspaceOf(agentTerminal(1)))
    expect(streams.inbox.watch).toHaveBeenCalledOnce()
    entries.push([entry()])
    await settle()
    expect(ids()).toEqual(["entry-1"])
    expect(inbox.state.getSnapshot().items[0]).toMatchObject({
      kind: "ask",
      stopped: true,
      at: 4000,
    })
    stop()
    expect(entries.returned).toHaveBeenCalledOnce()
    expect(ids()).toEqual([])
    entries.push([entry()])
    await settle()
    expect(ids()).toEqual([])
  })

  it("lists a waiting entry beside trouble, and keeps it once the trouble clears", async () => {
    const { entries, marks, inbox, ids } = setup(
      workspaceOf(agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed" }) })),
      failed,
    )
    entries.push([entry(), told()])
    await settle()
    expect(ids().toSorted()).toEqual(["entry-1", "told-1", "trouble:01:100"])
    marks({})
    await settle()
    expect(ids().toSorted()).toEqual(["entry-1", "told-1"])
    entries.push([told()])
    await settle()
    expect(inbox.state.getSnapshot().items[0]).toMatchObject({
      kind: "update",
      update: { type: "told" },
    })
  })

  it("lists the old agent's tell beside a new agent's ask until the tell is read", async () => {
    const { entries, inbox, streams, ids } = setup(
      workspaceOf(agentTerminal(1, { working: true }, "codex")),
    )
    const current = entry({ id: "new-ask", agent: "codex", sessionId: "new-session" })
    entries.push([entry(), told(), current])
    await settle()
    expect(ids().toSorted()).toEqual(["new-ask", "told-1"])
    entries.push([told()])
    await settle()
    expect(inbox.state.getSnapshot().items[0]).toMatchObject({
      id: "told-1",
      source: { agent: "claude" },
    })
    inbox.answer("told-1", { kind: "update", action: "read" })
    expect(streams.inbox.read).toHaveBeenCalledExactlyOnceWith(["told-1"])
  })

  it("reads a tell after its agent exited through mark all read", async () => {
    const exited: TerminalMetadata = {
      ...agentTerminal(1),
      state: "exited",
      exitCode: 0,
      signal: null,
    }
    const { entries, inbox, streams } = setup(workspaceOf(exited))
    entries.push([told()])
    await settle()
    inbox.readAll()
    await settle()
    expect(streams.inbox.read).toHaveBeenCalledExactlyOnceWith(["told-1"])
  })

  it("sends an answer once and stays pending until the runner takes it", async () => {
    const { entries, inbox, streams } = setup(workspaceOf(agentTerminal(1)))
    entries.push([entry()])
    await settle()
    let accepted: (() => void) | undefined
    streams.inbox.answer.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          accepted = resolve
        }),
    )
    const answer = {
      kind: "ask",
      answer: { type: "reply", option: null, text: "Use /retry." },
    } as const
    inbox.answer("entry-1", answer)
    inbox.answer("entry-1", answer)
    expect(streams.inbox.answer).toHaveBeenCalledExactlyOnceWith("entry-1", answer.answer)
    entries.push([])
    await settle()
    expect(inbox.state.getSnapshot().answering["entry-1"]).toBe(true)
    accepted!()
    await settle()
    expect(inbox.state.getSnapshot().answering).toEqual({})
  })

  it("keeps an ask pending beside trouble while its answer is unresolved", async () => {
    const { entries, inbox, streams, marks, workspaceStore } = setup(workspaceOf(agentTerminal(1)))
    entries.push([entry()])
    await settle()
    let accepted: (() => void) | undefined
    streams.inbox.answer.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          accepted = resolve
        }),
    )
    inbox.answer("entry-1", {
      kind: "ask",
      answer: { type: "reply", option: null, text: "My reply" },
    })
    workspaceStore.update(() =>
      workspaceOf(agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed" }) })),
    )
    marks(failed)
    await settle()
    expect(
      inbox.state
        .getSnapshot()
        .items.map(({ id }) => id)
        .toSorted(),
    ).toEqual(["entry-1", "trouble:01:100"])
    expect(inbox.state.getSnapshot().answering["entry-1"]).toBe(true)
    marks({})
    await settle()
    expect(inbox.state.getSnapshot().items.map(({ id }) => id)).toEqual(["entry-1"])
    expect(inbox.state.getSnapshot().answering["entry-1"]).toBe(true)
    accepted!()
    await settle()
  })

  it("shows a stale answer's failure even if the entry disappears before the reply", async () => {
    const { entries, inbox, streams } = setup(workspaceOf(agentTerminal(1)))
    entries.push([entry()])
    await settle()
    let reject: ((error: Error) => void) | undefined
    streams.inbox.answer.mockImplementationOnce(
      () =>
        new Promise<void>((_, refuse) => {
          reject = refuse
        }),
    )
    inbox.answer("entry-1", {
      kind: "ask",
      answer: { type: "reply", option: null, text: "My reply" },
    })
    entries.push([])
    await settle()
    reject!(new Error("That ask is no longer available."))
    await settle()
    expect(inbox.state.getSnapshot().answering).toEqual({})
    expect(inbox.state.getSnapshot().failed["entry-1"]).toBe("That ask is no longer available.")
  })

  it("reports an accepted reply that later cannot be delivered", async () => {
    const { entries, inbox, messagesStore } = setup(workspaceOf(agentTerminal(1)))
    entries.push([entry()])
    await settle()
    inbox.answer("entry-1", {
      kind: "ask",
      answer: { type: "reply", option: null, text: "My reply" },
    })
    entries.push([])
    await settle()
    expect(inbox.state.getSnapshot().failed).toEqual({})
    messagesStore.update(() =>
      messagesOf(
        thread({
          id: "t-entry1",
          peer: { kind: "person" },
          held: false,
          messages: [
            message({
              from: { kind: "person" },
              to: agentParty("moth"),
              inbox: "answer",
              state: "gone",
              held: null,
            }),
          ],
        }),
      ),
    )
    expect(inbox.state.getSnapshot().failed["entry-1"]).toBe(
      "Your reply was not delivered because the agent's session ended.",
    )
    messagesStore.update(() => noMessages)
    expect(inbox.state.getSnapshot().failed["entry-1"]).toContain("not delivered")
  })

  it("reports an undelivered ask trace even if its reply is no longer listed", async () => {
    const { entries, inbox, messagesStore } = setup(workspaceOf(agentTerminal(1)))
    entries.push([entry()])
    await settle()
    inbox.answer("entry-1", { kind: "ask", answer: { type: "done" } })
    entries.push([])
    await settle()
    messagesStore.update(() =>
      messagesOf(
        thread({
          id: "t-entry1",
          peer: { kind: "person" },
          held: false,
          messages: [
            message({
              inbox: "ask",
              inboxState: "undelivered",
              to: { kind: "person" },
              state: "delivered",
              held: null,
            }),
          ],
        }),
      ),
    )
    expect(inbox.state.getSnapshot().failed["entry-1"]).toContain("Your reply was not delivered")
  })

  it("retires tracking after delivery is acknowledged", async () => {
    const { entries, inbox, messagesStore } = setup(workspaceOf(agentTerminal(1)))
    entries.push([entry()])
    await settle()
    inbox.answer("entry-1", {
      kind: "ask",
      answer: { type: "reply", option: null, text: "My reply" },
    })
    entries.push([])
    await settle()
    const delivered = message({
      from: { kind: "person" },
      to: agentParty("moth"),
      inbox: "answer",
      state: "delivered",
      held: null,
      deliveredAt: 10_000,
    })
    messagesStore.update(() =>
      messagesOf(
        thread({ id: "t-entry1", peer: { kind: "person" }, held: false, messages: [delivered] }),
      ),
    )
    messagesStore.update(() =>
      messagesOf(
        thread({
          id: "t-entry1",
          peer: { kind: "person" },
          held: false,
          messages: [{ ...delivered, state: "gone", deliveredAt: null }],
        }),
      ),
    )
    expect(inbox.state.getSnapshot().failed["entry-1"]).toBeUndefined()
  })

  it("keeps failure visible after the terminal and its history disappear", async () => {
    const { entries, inbox, workspaceStore } = setup(workspaceOf(agentTerminal(1)))
    entries.push([entry()])
    await settle()
    inbox.answer("entry-1", {
      kind: "ask",
      answer: { type: "reply", option: null, text: "My reply" },
    })
    entries.push([])
    await settle()
    workspaceStore.update(() => workspaceOf())
    expect(inbox.state.getSnapshot().failed["entry-1"]).toContain("Your reply was not delivered")
    workspaceStore.update(() => workspaceOf(agentTerminal(1)))
    expect(inbox.state.getSnapshot().failed["entry-1"]).toContain("Your reply was not delivered")
  })

  it("retires a reply when its previously observed history is evicted", async () => {
    const { entries, inbox, messagesStore } = setup(workspaceOf(agentTerminal(1)))
    entries.push([entry()])
    await settle()
    inbox.answer("entry-1", {
      kind: "ask",
      answer: { type: "reply", option: null, text: "My reply" },
    })
    entries.push([])
    await settle()
    const response = message({
      from: { kind: "person" },
      to: agentParty("moth"),
      inbox: "answer",
      state: "queued",
      held: null,
    })
    messagesStore.update(() =>
      messagesOf(
        thread({ id: "t-entry1", peer: { kind: "person" }, held: false, messages: [response] }),
      ),
    )
    messagesStore.update(() => noMessages)
    messagesStore.update(() =>
      messagesOf(
        thread({
          id: "t-entry1",
          peer: { kind: "person" },
          held: false,
          messages: [{ ...response, state: "gone" }],
        }),
      ),
    )
    expect(inbox.state.getSnapshot().failed["entry-1"]).toBeUndefined()
  })

  it("bounds replies whose history has not arrived while keeping recent failures observable", async () => {
    const { entries, inbox, messagesStore } = setup(workspaceOf(agentTerminal(1)))
    for (let index = 0; index <= 1000; index += 1) {
      entries.push([entry({ id: `queued-${index}` })])
      // eslint-disable-next-line no-await-in-loop -- Each ask must reach the Inbox before it can be answered.
      await settle()
      inbox.answer(`queued-${index}`, {
        kind: "ask",
        answer: { type: "reply", option: null, text: "My reply" },
      })
    }
    entries.push([])
    await settle()
    const lost = message({
      from: { kind: "person" },
      to: agentParty("moth"),
      inbox: "answer",
      state: "gone",
      held: null,
    })
    messagesStore.update(() =>
      messagesOf(
        thread({ id: "t-queued0", peer: { kind: "person" }, held: false, messages: [lost] }),
      ),
    )
    expect(inbox.state.getSnapshot().failed["queued-0"]).toBeUndefined()
    messagesStore.update(() =>
      messagesOf(
        thread({ id: "t-queued1000", peer: { kind: "person" }, held: false, messages: [lost] }),
      ),
    )
    expect(inbox.state.getSnapshot().failed["queued-1000"]).toContain(
      "Your reply was not delivered",
    )
  })

  it("keeps a size rejection's error when the terminal later closes", async () => {
    const { entries, inbox, streams, workspaceStore } = setup(workspaceOf(agentTerminal(1)))
    entries.push([entry()])
    await settle()
    streams.inbox.answer.mockRejectedValueOnce(
      new Error("This reply exceeds the delivery size limit."),
    )
    inbox.answer("entry-1", {
      kind: "ask",
      answer: { type: "reply", option: null, text: "My reply" },
    })
    await settle()
    workspaceStore.update(() => workspaceOf())
    expect(inbox.state.getSnapshot().failed["entry-1"]).toBe(
      "This reply exceeds the delivery size limit.",
    )
  })

  it("reads a told update through the runner", async () => {
    const { entries, inbox, streams } = setup(workspaceOf(agentTerminal(1)))
    entries.push([told()])
    await settle()
    inbox.answer("told-1", { kind: "update", action: "read" })
    expect(streams.inbox.read).toHaveBeenCalledExactlyOnceWith(["told-1"])
  })

  it("reads a done report through the runner, and lists it after its agent exited", async () => {
    const exited: TerminalMetadata = {
      ...agentTerminal(1),
      state: "exited",
      exitCode: 0,
      signal: null,
    }
    const { entries, inbox, streams, ids } = setup(workspaceOf(exited))
    entries.push([entry({ id: "done-1", content: { kind: "done", subject: "s", body: "b" } })])
    await settle()
    expect(inbox.state.getSnapshot().items).toMatchObject([
      { id: "done-1", kind: "update", update: { type: "done" } },
    ])
    inbox.answer("done-1", { kind: "update", action: "read" })
    expect(streams.inbox.read).toHaveBeenCalledExactlyOnceWith(["done-1"])
    inbox.readAll()
    await settle()
    expect(ids()).toEqual(["done-1"])
  })

  it("reads a worker's done under its running lead when everything is read, as the person's", async () => {
    const worker: TerminalMetadata = { ...agentTerminal(2, { working: false }), ledBy: "moth" }
    const { entries, inbox, streams, ids } = setup(workspaceOf(agentTerminal(1), worker))
    entries.push([
      entry({
        id: "worker-done",
        terminalId: "02",
        handle: "fox",
        content: { kind: "done", subject: "s", body: "b" },
      }),
      told(),
    ])
    await settle()
    expect(ids()).toEqual(["worker-done", "told-1"])
    inbox.readAll()
    await settle()
    expect(streams.inbox.read).toHaveBeenCalledExactlyOnceWith(["worker-done", "told-1"])
  })

  it("reads all known tells in batches, beside the more urgent ask", async () => {
    const { entries, inbox, streams, ids } = setup(workspaceOf(agentTerminal(1)))
    const tells = Array.from({ length: 1001 }, (_, index) => told(`tell-${index}`))
    entries.push([entry(), ...tells])
    await settle()
    expect(ids()).toHaveLength(1002)
    expect(ids()[0]).toBe("entry-1")
    inbox.readAll()
    await settle()
    expect(streams.inbox.read.mock.calls.map(([batch]) => batch.length)).toEqual([1000, 1])
    expect(streams.inbox.answer).not.toHaveBeenCalled()
    // Submitted tells stay listed, answering, until the runner drops them.
    expect(ids()).toHaveLength(1002)
    expect(ids()).toContain("entry-1")
  })
})

describe("Dismissing an ask", () => {
  const settledEntry = (id = "entry-1", at = 9000): InboxEntry =>
    entry({ id, settled: { how: "dismissed", at } })

  it("asks the runner to dismiss an open ask, which answers until the runner lists it settled", async () => {
    const { entries, inbox, streams, ids } = setup(workspaceOf(agentTerminal(1)))
    entries.push([entry()])
    await settle()
    inbox.dismiss!("entry-1")
    expect(streams.inbox.dismiss).toHaveBeenCalledExactlyOnceWith("entry-1")
    await settle()
    expect(inbox.state.getSnapshot().answering).toEqual({ "entry-1": true })
    entries.push([settledEntry()])
    await settle()
    expect(ids()).toEqual(["entry-1"])
    expect(inbox.state.getSnapshot().items[0]).toMatchObject({
      kind: "ask",
      stopped: false,
      settled: { how: "dismissed", at: 9000 },
    })
    expect(inbox.state.getSnapshot().answering).toEqual({})
  })

  it("leaves the ask open, with no answer error, when the runner refuses", async () => {
    const { entries, inbox, streams } = setup(workspaceOf(agentTerminal(1)))
    entries.push([entry()])
    await settle()
    streams.inbox.dismiss.mockRejectedValueOnce(new Error("no such ask"))
    inbox.dismiss!("entry-1")
    await settle()
    const state = inbox.state.getSnapshot()
    expect(state.answering).toEqual({})
    expect(state.failed["entry-1"]).toBeUndefined()
    expect(state.items[0]!.settled).toBeUndefined()
  })

  it("does not send an answer to a settled ask", async () => {
    const { entries, inbox, streams } = setup(workspaceOf(agentTerminal(1)))
    entries.push([settledEntry()])
    await settle()
    inbox.answer("entry-1", { kind: "ask", answer: { type: "reply", option: null, text: "x" } })
    expect(streams.inbox.answer).not.toHaveBeenCalled()
  })

  it("does not dismiss a settled ask, an update or an unknown id", async () => {
    const { entries, inbox, streams } = setup(workspaceOf(agentTerminal(1)))
    entries.push([settledEntry(), told()])
    await settle()
    for (const id of ["entry-1", "told-1", "nope"]) inbox.dismiss!(id)
    expect(streams.inbox.dismiss).not.toHaveBeenCalled()
  })

  it("clears settled asks in batches of a thousand, and no open ask or update", async () => {
    const { entries, inbox, streams } = setup(workspaceOf(agentTerminal(1)))
    const settled = Array.from({ length: 1001 }, (_, index) => settledEntry(`old-${index}`))
    entries.push([entry({ id: "open" }), told(), ...settled])
    await settle()
    inbox.clear!(["open", "told-1", "unknown", ...settled.map(({ id }) => id)])
    await settle()
    expect(streams.inbox.clear.mock.calls.map(([batch]) => batch.length)).toEqual([1000, 1])
    expect(streams.inbox.clear.mock.calls.flat(2)).not.toContain("open")
  })

  it("surfaces a failed clear on the rows it was for", async () => {
    const { entries, inbox, streams } = setup(workspaceOf(agentTerminal(1)))
    entries.push([settledEntry()])
    await settle()
    streams.inbox.clear.mockRejectedValueOnce(new Error("down"))
    inbox.clear!(["entry-1"])
    await settle()
    expect(inbox.state.getSnapshot().failed["entry-1"]).toBeTruthy()
  })
})

describe("Turn rows", () => {
  const ws = () =>
    workspaceOf(
      agentTerminal(1, { working: false, lastTurn: turn({ reply: "a" }) }),
      agentTerminal(2, { working: false, lastTurn: turn({ reply: "b", at: 200 }) }),
    )
  const both: Marks = { "p/s": { "01": "done", "02": "done" } }
  const bothFailed: Marks = { "p/s": { "01": "failed", "02": "failed" } }
  const finish = { context: "p/s", terminalId: "01" }

  it("has no turns until the first listing, and none after the listing ended for good", async () => {
    const { inbox, entries, stop } = setup(ws(), both)
    expect(inbox.turns.getSnapshot()).toBeUndefined()
    await settle()
    expect(inbox.turns.getSnapshot()?.map(({ id }) => id)).toEqual([
      "update:01:100",
      "update:02:200",
    ])
    expect(inbox.turns.getSnapshot()?.[0]).toMatchObject({
      outcome: "completed",
      reply: "a",
      error: null,
      files: [],
      terminalId: "01",
    })

    entries.stream.return!()
    stop()
    expect(inbox.turns.getSnapshot()).toBeUndefined()
  })

  it("is undefined again when the iterator ends on its own", async () => {
    const feed = pushed<InboxEntry[]>()
    const streams = {
      inbox: {
        watch: () => feed.stream,
        answer: async () => {},
        read: async () => {},
        dismiss: async () => {},
        clear: async () => {},
      },
      detail: () => pushed<AgentDetail>().stream,
      answer: async () => {},
      send: async () => {},
      interrupt: async () => null,
      release: () => {},
      stop: () => {},
    } satisfies InboxStreams
    const inbox = createRunnerInbox(streams, createStore(noMessages))
    inbox.bind({ workspace: createStore(ws()) })
    feed.push([])
    await settle()
    expect(inbox.turns.getSnapshot()).toEqual([])

    feed.finish()
    await settle()
    expect(inbox.turns.getSnapshot()).toBeUndefined()
  })

  it("hides a viewed terminal's rows at once, and keeps them hidden until a listing drops them", async () => {
    const { inbox, streams, entries, ids } = setup(ws(), bothFailed)
    await settle()
    let answered: (() => void) | undefined
    streams.inbox.read.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          answered = resolve
        }),
    )

    inbox.readFinishes([finish])
    expect(inbox.turns.getSnapshot()?.map(({ id }) => id)).toEqual(["trouble:02:200"])
    expect(ids()).toEqual(["trouble:02:200"])
    expect(inbox.state.getSnapshot().answering).toEqual({})
    await settle()
    expect(streams.inbox.read).toHaveBeenCalledExactlyOnceWith(["trouble:01:100"])

    // A listing that still holds it keeps it hidden, and sends nothing while it is on its way.
    entries.push([])
    await settle()
    expect(ids()).toEqual(["trouble:02:200"])
    expect(streams.inbox.read).toHaveBeenCalledOnce()
    answered!()
    await settle()
    expect(inbox.turns.getSnapshot()?.map(({ id }) => id)).toEqual(["trouble:02:200"])
  })

  it("reads again only on the next listing or after a backoff, never on its own change", async () => {
    const { inbox, streams, entries } = setup(ws(), both)
    await settle()
    streams.inbox.read.mockRejectedValueOnce(new Error("down"))
    inbox.readFinishes([finish])
    await settle()
    expect(streams.inbox.read).toHaveBeenCalledTimes(1)
    expect(inbox.state.getSnapshot().failed).toEqual({})
    expect(inbox.state.getSnapshot().answering).toEqual({})

    // The backoff, 1 s then doubling, retries it.
    streams.inbox.read.mockRejectedValueOnce(new Error("down"))
    await vi.advanceTimersByTimeAsync(retryMs)
    expect(streams.inbox.read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(retryMs)
    expect(streams.inbox.read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(retryMs)
    expect(streams.inbox.read).toHaveBeenCalledTimes(3)

    // A listing that still holds a row not on its way sends it again.
    streams.inbox.read.mockRejectedValueOnce(new Error("down"))
    inbox.readFinishes([{ context: "p/s", terminalId: "02" }])
    await settle()
    entries.push([])
    await settle()
    expect(streams.inbox.read.mock.calls.map(([ids]) => ids)).toContainEqual(["update:02:200"])
  })

  it("reads a row that lands later when the terminal is read again", async () => {
    const { inbox, streams, entries } = setup(ws(), { "p/s": { "01": "done" } })
    await settle()
    inbox.readFinishes([finish])
    await settle()
    expect(streams.inbox.read).toHaveBeenCalledTimes(1)

    const next = { ...turnEntriesOf(ws(), done)[0]!, id: "later", at: 300 }
    entries.push([next])
    await settle()
    expect(inbox.turns.getSnapshot()?.map(({ id }) => id)).toEqual(["later"])
    inbox.readFinishes([finish])
    await settle()
    expect(streams.inbox.read).toHaveBeenLastCalledWith(["later"])
    expect(inbox.turns.getSnapshot()).toEqual([])
  })

  it("keeps rows hidden under a lead in turns, and out of the items", async () => {
    const worker: TerminalMetadata = {
      ...agentTerminal(2, { working: false, lastTurn: turn({ at: 200 }) }),
      ledBy: "moth",
    }
    const { inbox, ids } = setup(workspaceOf(agentTerminal(1), worker), {
      "p/s": { "02": "done" },
    })
    await settle()

    expect(ids()).toEqual([])
    expect(inbox.turns.getSnapshot()?.map(({ id }) => id)).toEqual(["update:02:200"])
  })

  it("publishes the latest when a turns subscriber reads inside the notification", async () => {
    const { inbox, ids } = setup(ws(), { "p/s": { "01": "failed" } })
    inbox.turns.subscribe(() => {
      if (inbox.turns.getSnapshot()?.length) inbox.readFinishes([finish])
    })
    await settle()

    expect(inbox.turns.getSnapshot()).toEqual([])
    expect(ids()).toEqual([])
  })

  it("lets a batch go again after its read threw before returning a promise", async () => {
    const { inbox, streams } = setup(ws(), both)
    await settle()
    streams.inbox.read.mockImplementationOnce(() => {
      throw new Error("sync")
    })
    inbox.readFinishes([finish])
    await settle()
    await vi.advanceTimersByTimeAsync(retryMs)

    expect(streams.inbox.read).toHaveBeenCalledTimes(2)
  })

  it("shows a row of a terminal without a handle, and reads it with mark all read", async () => {
    const bare: TerminalMetadata = {
      ...agentTerminal(1, { working: false, lastTurn: turn({ reply: "a" }) }),
    }
    delete (bare as { handle?: string }).handle
    const ws2 = workspaceOf(bare)
    const { inbox, streams, entries, ids } = setup(ws2)
    entries.push([{ ...turnEntriesOf(ws2, failed)[0]!, handle: "", id: "old-row", at: 50 }])
    await settle()
    expect(ids()).toEqual(["old-row"])

    inbox.readAll()
    await settle()
    expect(streams.inbox.read).toHaveBeenCalledExactlyOnceWith(["old-row"])
  })
})
