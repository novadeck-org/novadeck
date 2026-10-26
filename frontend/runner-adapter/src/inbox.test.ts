import type { ChatDialog } from "@novadeck/core/conversation"
import type { InboxBinding } from "@novadeck/core/inbox"
import { dialogMs, type Asked } from "@novadeck/core/inbox-items"
import {
  noMail,
  type AgentMessage,
  type MailState,
  type MessageThread,
} from "@novadeck/core/messages"
import { createTerminalState } from "@novadeck/core/state"
import { createStore } from "@novadeck/core/store"
import type { AgentStatus, AgentTurnEnd, TerminalMetadata, Workspace } from "@novadeck/core/types"
import { longHoldMs, type AgentDetail, type InboxLetter } from "@novadeck/protocol"
import { afterEach, beforeEach, vi } from "vitest"

import { createRunnerInbox, detailGraceMs, retryMs, settleMs, type InboxStreams } from "./inbox"
import { describe, expect, it } from "./test"

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
  from: "moth",
  to: "fox",
  text: "Is the schema ready?",
  sentAt: 50,
  state: "held",
  held: "release",
  deliveredAt: null,
  ...change,
})

const thread = (change: Partial<MessageThread> = {}): MessageThread => ({
  id: "th1",
  peer: "fox",
  hops: 3,
  idle: 0,
  held: true,
  heldFor: "loop",
  messages: [message()],
  ...change,
})

const mailOf = (...threads: MessageThread[]): MailState => ({
  ...noMail,
  terminals: { "p/s/01": { handle: "moth", agent: true, threads } },
})

// The finished turns the tests state, by session context then terminal: each stands for the
// stored row of that terminal's current end, as the runner lists it.
type Marks = Readonly<Record<string, Readonly<Record<string, "done" | "failed">>>>
const done: Marks = { "p/s": { "01": "done" } }
const failed: Marks = { "p/s": { "01": "failed" } }

const turnLettersOf = (workspace: Workspace, marks: Marks): InboxLetter[] =>
  workspace.projects.flatMap((project) =>
    project.history.flatMap((session) =>
      session.state.roster.terminals.flatMap((terminal): InboxLetter[] => {
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

const setup = (workspace: Workspace, unread: Marks = {}, mail: MailState = noMail) => {
  const details: ReturnType<typeof pushed<AgentDetail>>[] = []
  const feed = pushed<InboxLetter[]>()
  // What the runner lists: the asks and tells a test pushes, and the turn rows its marks
  // stand for, which reading removes.
  let others: InboxLetter[] = []
  let rows: InboxLetter[] = []
  const publish = () => feed.push([...others, ...rows])
  const letters = {
    stream: feed.stream,
    returned: feed.returned,
    push: (list: InboxLetter[]) => {
      others = list
      publish()
    },
  }
  const streams = {
    asks: {
      watch: vi.fn<InboxStreams["asks"]["watch"]>(() => feed.stream),
      answer: vi.fn<InboxStreams["asks"]["answer"]>(async () => {}),
      read: vi.fn<InboxStreams["asks"]["read"]>(async (ids) => {
        const gone = ({ id, content }: InboxLetter) => content.kind === "turn" && ids.includes(id)
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
  const mailStore = createStore(mail)
  // The runner now lists these marks' rows.
  const marks = (next: Marks): void => {
    rows = turnLettersOf(workspaceStore.getSnapshot(), next)
    publish()
  }
  // The messages track a release or a stop in the mail state, as the runner backend's do.
  const releasing = (id: string) =>
    mailStore.update((current) => ({
      ...current,
      releasing: { ...current.releasing, [id]: "asked" },
    }))
  streams.release.mockImplementation(releasing)
  streams.stop.mockImplementation(releasing)
  const inbox = createRunnerInbox(streams, mailStore)
  const binding: InboxBinding = { workspace: workspaceStore }
  if (Object.keys(unread).length > 0) marks(unread)
  const stop = inbox.bind(binding)
  const ids = () => inbox.state.getSnapshot().items.map((item) => item.id)
  return {
    inbox,
    streams,
    details,
    letters,
    workspaceStore,
    marks,
    mailStore,
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
      const { marks, mailStore, ids } = setup(pair)
      expect(ids()).toEqual([])

      marks(done)
      await settle()
      expect(ids()).toEqual([])

      marks(failed)
      await settle()
      expect(ids()).toEqual(["trouble:01:100"])

      mailStore.update(() => mailOf(thread()))
      expect(ids().toSorted()).toEqual(["held:th1", "trouble:01:100"])
      mailStore.update(() => mailOf(thread({ held: false })))
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
      const mail: MailState = {
        ...noMail,
        terminals: {
          "p/s/02": {
            handle: "fox",
            agent: true,
            waits: "draft",
            waitsSince: 10_000,
            threads: [
              thread({
                peer: "moth",
                held: false,
                messages: [message({ state: "queued", held: null })],
              }),
            ],
          },
        },
      }
      const { ids } = setup(pair, {}, mail)
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
      const { inbox, streams, mailStore, ids } = setup(pair, {}, mailOf(thread()))
      inbox.answer("held:th1", { kind: "held", action: "release" })
      expect(streams.release).toHaveBeenCalledWith("th1")
      expect(inbox.state.getSnapshot().answering).toEqual({ "held:th1": true })

      mailStore.update(() => mailOf(thread({ held: false })))
      expect(ids()).toEqual([])
      expect(inbox.state.getSnapshot().answering).toEqual({})

      mailStore.update(() => ({ ...mailOf(thread({ id: "th2" })), releasing: {} }))
      inbox.answer("held:th2", { kind: "held", action: "stop" })
      expect(streams.stop).toHaveBeenCalledWith("th2")
    })

    it("says why the messages couldn't release a thread, and answers as the pane's release does", () => {
      const pair = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const { inbox, mailStore } = setup(pair, {}, mailOf(thread()))
      mailStore.update((current) => ({ ...current, releasing: { th1: "asked" } }))
      expect(inbox.state.getSnapshot().answering).toEqual({ "held:th1": true })

      mailStore.update((current) => ({
        ...current,
        releasing: {},
        failed: { th1: "Couldn't release it: lost" },
      }))
      expect(inbox.state.getSnapshot().answering).toEqual({})
      expect(inbox.state.getSnapshot().failed).toEqual({ "held:th1": "Couldn't release it: lost" })
    })
  })

  describe("updates", () => {
    const report = (id: string, change: Partial<InboxLetter> = {}): InboxLetter =>
      letter({
        id,
        content: { kind: "done", subject: `Report ${id}`, body: "All of it." },
        ...change,
      })
    const two = () => workspaceOf(agentTerminal(1), agentTerminal(2, { working: false }, "codex"))
    const fox = { terminalId: "02", handle: "fox", agent: "codex" as const }

    it("reads a done report by its id, which the runner drops", async () => {
      const { inbox, streams, letters, ids } = setup(two())
      letters.push([report("done-1"), report("done-2", fox)])
      await settle()
      expect(ids().toSorted()).toEqual(["done-1", "done-2"])
      inbox.answer("done-1", { kind: "update", action: "read" })
      expect(inbox.state.getSnapshot().answering).toEqual({ "done-1": true })
      await settle()

      expect(streams.asks.read).toHaveBeenCalledExactlyOnceWith(["done-1"])
      letters.push([report("done-2", fox)])
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
      const { inbox, streams, letters, marks, ids } = setup(ws, { "p/s": { "01": "failed" } })
      await settle()
      const older = {
        ...turnLettersOf(ws, { "p/s": { "01": "failed" } })[0]!,
        id: "old-row",
        at: 50,
      }
      letters.push([older])
      await settle()
      expect(ids().toSorted()).toEqual(["old-row", "trouble:01:200"])

      inbox.answer("old-row", { kind: "trouble", action: { type: "read" } })
      inbox.answer("trouble:01:200", { kind: "trouble", action: { type: "read" } })
      await settle()

      expect(streams.asks.read.mock.calls.map(([batch]) => batch)).toEqual([
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
      const { inbox, streams, letters, ids } = setup(waiting, { "p/s": { "02": "failed" } })
      await settle()
      letters.push([
        report("done-1"),
        told("told-1"),
        {
          ...turnLettersOf(waiting, { "p/s": { "02": "failed" } })[0]!,
          id: "old-row",
          at: 50,
        },
      ])
      await settle()
      inbox.readAll()
      await settle()

      expect(streams.asks.read).toHaveBeenCalledOnce()
      expect(streams.asks.read.mock.calls[0]![0].toSorted()).toEqual([
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
      const { inbox, letters } = setup(two())
      letters.push([report("done-1"), report("done-2", fox)])
      await settle()
      inbox.see("done-1")
      const seen = () =>
        inbox.state
          .getSnapshot()
          .items.toSorted((a, b) => a.id.localeCompare(b.id))
          .map((item) => item.seen)
      expect(seen()).toEqual([true, false])

      letters.push([report("done-2", fox)])
      await settle()
      letters.push([report("done-1"), report("done-2", fox)])
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

      expect(streams.asks.read).toHaveBeenCalledExactlyOnceWith(["trouble:01:100"])
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

const letter = (change: Partial<InboxLetter> = {}): InboxLetter => ({
  id: "letter-1",
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

const told = (id = "told-1"): InboxLetter =>
  letter({ id, content: { kind: "tell", subject: "Preview ready", body: "Open the preview." } })

describe("Inbox letters", () => {
  it("follows one global stream while bound and closes it when unbound", async () => {
    const { inbox, streams, letters, stop, ids } = setup(workspaceOf(agentTerminal(1)))
    expect(streams.asks.watch).toHaveBeenCalledOnce()
    letters.push([letter()])
    await settle()
    expect(ids()).toEqual(["letter-1"])
    expect(inbox.state.getSnapshot().items[0]).toMatchObject({
      kind: "ask",
      stopped: true,
      at: 4000,
    })
    stop()
    expect(letters.returned).toHaveBeenCalledOnce()
    expect(ids()).toEqual([])
    letters.push([letter()])
    await settle()
    expect(ids()).toEqual([])
  })

  it("lists a waiting letter beside trouble, and keeps it once the trouble clears", async () => {
    const { letters, marks, inbox, ids } = setup(
      workspaceOf(agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed" }) })),
      failed,
    )
    letters.push([letter(), told()])
    await settle()
    expect(ids().toSorted()).toEqual(["letter-1", "told-1", "trouble:01:100"])
    marks({})
    await settle()
    expect(ids().toSorted()).toEqual(["letter-1", "told-1"])
    letters.push([told()])
    await settle()
    expect(inbox.state.getSnapshot().items[0]).toMatchObject({
      kind: "update",
      update: { type: "told" },
    })
  })

  it("lists the old agent's tell beside a new agent's ask until the tell is read", async () => {
    const { letters, inbox, streams, ids } = setup(
      workspaceOf(agentTerminal(1, { working: true }, "codex")),
    )
    const current = letter({ id: "new-ask", agent: "codex", sessionId: "new-session" })
    letters.push([letter(), told(), current])
    await settle()
    expect(ids().toSorted()).toEqual(["new-ask", "told-1"])
    letters.push([told()])
    await settle()
    expect(inbox.state.getSnapshot().items[0]).toMatchObject({
      id: "told-1",
      source: { agent: "claude" },
    })
    inbox.answer("told-1", { kind: "update", action: "read" })
    expect(streams.asks.read).toHaveBeenCalledExactlyOnceWith(["told-1"])
  })

  it("reads a tell after its agent exited through mark all read", async () => {
    const exited: TerminalMetadata = {
      ...agentTerminal(1),
      state: "exited",
      exitCode: 0,
      signal: null,
    }
    const { letters, inbox, streams } = setup(workspaceOf(exited))
    letters.push([told()])
    await settle()
    inbox.readAll()
    await settle()
    expect(streams.asks.read).toHaveBeenCalledExactlyOnceWith(["told-1"])
  })

  it("sends an answer once and stays pending until the runner takes it", async () => {
    const { letters, inbox, streams } = setup(workspaceOf(agentTerminal(1)))
    letters.push([letter()])
    await settle()
    let accepted: (() => void) | undefined
    streams.asks.answer.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          accepted = resolve
        }),
    )
    const answer = {
      kind: "ask",
      answer: { type: "reply", option: null, text: "Use /retry." },
    } as const
    inbox.answer("letter-1", answer)
    inbox.answer("letter-1", answer)
    expect(streams.asks.answer).toHaveBeenCalledExactlyOnceWith("letter-1", answer.answer)
    letters.push([])
    await settle()
    expect(inbox.state.getSnapshot().answering["letter-1"]).toBe(true)
    accepted!()
    await settle()
    expect(inbox.state.getSnapshot().answering).toEqual({})
  })

  it("keeps an ask pending beside trouble while its answer is unresolved", async () => {
    const { letters, inbox, streams, marks, workspaceStore } = setup(workspaceOf(agentTerminal(1)))
    letters.push([letter()])
    await settle()
    let accepted: (() => void) | undefined
    streams.asks.answer.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          accepted = resolve
        }),
    )
    inbox.answer("letter-1", {
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
    ).toEqual(["letter-1", "trouble:01:100"])
    expect(inbox.state.getSnapshot().answering["letter-1"]).toBe(true)
    marks({})
    await settle()
    expect(inbox.state.getSnapshot().items.map(({ id }) => id)).toEqual(["letter-1"])
    expect(inbox.state.getSnapshot().answering["letter-1"]).toBe(true)
    accepted!()
    await settle()
  })

  it("shows a stale answer's failure even if the letter disappears before the reply", async () => {
    const { letters, inbox, streams } = setup(workspaceOf(agentTerminal(1)))
    letters.push([letter()])
    await settle()
    let reject: ((error: Error) => void) | undefined
    streams.asks.answer.mockImplementationOnce(
      () =>
        new Promise<void>((_, refuse) => {
          reject = refuse
        }),
    )
    inbox.answer("letter-1", {
      kind: "ask",
      answer: { type: "reply", option: null, text: "My reply" },
    })
    letters.push([])
    await settle()
    reject!(new Error("That ask is no longer available."))
    await settle()
    expect(inbox.state.getSnapshot().answering).toEqual({})
    expect(inbox.state.getSnapshot().failed["letter-1"]).toBe("That ask is no longer available.")
  })

  it("reports an accepted reply that later cannot be delivered", async () => {
    const { letters, inbox, mailStore } = setup(workspaceOf(agentTerminal(1)))
    letters.push([letter()])
    await settle()
    inbox.answer("letter-1", {
      kind: "ask",
      answer: { type: "reply", option: null, text: "My reply" },
    })
    letters.push([])
    await settle()
    expect(inbox.state.getSnapshot().failed).toEqual({})
    mailStore.update(() =>
      mailOf(
        thread({
          id: "t-letter1",
          peer: "you",
          held: false,
          messages: [
            message({ from: "you", to: "moth", inbox: "answer", state: "gone", held: null }),
          ],
        }),
      ),
    )
    expect(inbox.state.getSnapshot().failed["letter-1"]).toBe(
      "Your reply was not delivered because the agent's session ended.",
    )
    mailStore.update(() => noMail)
    expect(inbox.state.getSnapshot().failed["letter-1"]).toContain("not delivered")
  })

  it("reports an undelivered ask trace even if its reply is no longer listed", async () => {
    const { letters, inbox, mailStore } = setup(workspaceOf(agentTerminal(1)))
    letters.push([letter()])
    await settle()
    inbox.answer("letter-1", { kind: "ask", answer: { type: "done" } })
    letters.push([])
    await settle()
    mailStore.update(() =>
      mailOf(
        thread({
          id: "t-letter1",
          peer: "you",
          held: false,
          messages: [
            message({
              inbox: "ask",
              inboxState: "undelivered",
              to: "you",
              state: "delivered",
              held: null,
            }),
          ],
        }),
      ),
    )
    expect(inbox.state.getSnapshot().failed["letter-1"]).toContain("Your reply was not delivered")
  })

  it("retires tracking after delivery is acknowledged", async () => {
    const { letters, inbox, mailStore } = setup(workspaceOf(agentTerminal(1)))
    letters.push([letter()])
    await settle()
    inbox.answer("letter-1", {
      kind: "ask",
      answer: { type: "reply", option: null, text: "My reply" },
    })
    letters.push([])
    await settle()
    const delivered = message({
      from: "you",
      to: "moth",
      inbox: "answer",
      state: "delivered",
      held: null,
      deliveredAt: 10_000,
    })
    mailStore.update(() =>
      mailOf(thread({ id: "t-letter1", peer: "you", held: false, messages: [delivered] })),
    )
    mailStore.update(() =>
      mailOf(
        thread({
          id: "t-letter1",
          peer: "you",
          held: false,
          messages: [{ ...delivered, state: "gone", deliveredAt: null }],
        }),
      ),
    )
    expect(inbox.state.getSnapshot().failed["letter-1"]).toBeUndefined()
  })

  it("keeps failure visible after the terminal and its history disappear", async () => {
    const { letters, inbox, workspaceStore } = setup(workspaceOf(agentTerminal(1)))
    letters.push([letter()])
    await settle()
    inbox.answer("letter-1", {
      kind: "ask",
      answer: { type: "reply", option: null, text: "My reply" },
    })
    letters.push([])
    await settle()
    workspaceStore.update(() => workspaceOf())
    expect(inbox.state.getSnapshot().failed["letter-1"]).toContain("Your reply was not delivered")
    workspaceStore.update(() => workspaceOf(agentTerminal(1)))
    expect(inbox.state.getSnapshot().failed["letter-1"]).toContain("Your reply was not delivered")
  })

  it("retires a reply when its previously observed history is evicted", async () => {
    const { letters, inbox, mailStore } = setup(workspaceOf(agentTerminal(1)))
    letters.push([letter()])
    await settle()
    inbox.answer("letter-1", {
      kind: "ask",
      answer: { type: "reply", option: null, text: "My reply" },
    })
    letters.push([])
    await settle()
    const response = message({
      from: "you",
      to: "moth",
      inbox: "answer",
      state: "queued",
      held: null,
    })
    mailStore.update(() =>
      mailOf(thread({ id: "t-letter1", peer: "you", held: false, messages: [response] })),
    )
    mailStore.update(() => noMail)
    mailStore.update(() =>
      mailOf(
        thread({
          id: "t-letter1",
          peer: "you",
          held: false,
          messages: [{ ...response, state: "gone" }],
        }),
      ),
    )
    expect(inbox.state.getSnapshot().failed["letter-1"]).toBeUndefined()
  })

  it("bounds replies whose history has not arrived while keeping recent failures observable", async () => {
    const { letters, inbox, mailStore } = setup(workspaceOf(agentTerminal(1)))
    for (let index = 0; index <= 1000; index += 1) {
      letters.push([letter({ id: `queued-${index}` })])
      // eslint-disable-next-line no-await-in-loop -- Each ask must reach the Inbox before it can be answered.
      await settle()
      inbox.answer(`queued-${index}`, {
        kind: "ask",
        answer: { type: "reply", option: null, text: "My reply" },
      })
    }
    letters.push([])
    await settle()
    const lost = message({ from: "you", to: "moth", inbox: "answer", state: "gone", held: null })
    mailStore.update(() =>
      mailOf(thread({ id: "t-queued0", peer: "you", held: false, messages: [lost] })),
    )
    expect(inbox.state.getSnapshot().failed["queued-0"]).toBeUndefined()
    mailStore.update(() =>
      mailOf(thread({ id: "t-queued1000", peer: "you", held: false, messages: [lost] })),
    )
    expect(inbox.state.getSnapshot().failed["queued-1000"]).toContain(
      "Your reply was not delivered",
    )
  })

  it("keeps a size rejection's error when the terminal later closes", async () => {
    const { letters, inbox, streams, workspaceStore } = setup(workspaceOf(agentTerminal(1)))
    letters.push([letter()])
    await settle()
    streams.asks.answer.mockRejectedValueOnce(
      new Error("This reply exceeds the delivery size limit."),
    )
    inbox.answer("letter-1", {
      kind: "ask",
      answer: { type: "reply", option: null, text: "My reply" },
    })
    await settle()
    workspaceStore.update(() => workspaceOf())
    expect(inbox.state.getSnapshot().failed["letter-1"]).toBe(
      "This reply exceeds the delivery size limit.",
    )
  })

  it("reads a told update through the runner", async () => {
    const { letters, inbox, streams } = setup(workspaceOf(agentTerminal(1)))
    letters.push([told()])
    await settle()
    inbox.answer("told-1", { kind: "update", action: "read" })
    expect(streams.asks.read).toHaveBeenCalledExactlyOnceWith(["told-1"])
  })

  it("reads a done report through the runner, and lists it after its agent exited", async () => {
    const exited: TerminalMetadata = {
      ...agentTerminal(1),
      state: "exited",
      exitCode: 0,
      signal: null,
    }
    const { letters, inbox, streams, ids } = setup(workspaceOf(exited))
    letters.push([letter({ id: "done-1", content: { kind: "done", subject: "s", body: "b" } })])
    await settle()
    expect(inbox.state.getSnapshot().items).toMatchObject([
      { id: "done-1", kind: "update", update: { type: "done" } },
    ])
    inbox.answer("done-1", { kind: "update", action: "read" })
    expect(streams.asks.read).toHaveBeenCalledExactlyOnceWith(["done-1"])
    inbox.readAll()
    await settle()
    expect(ids()).toEqual(["done-1"])
  })

  it("leaves a worker's done unread under its running lead when everything is read", async () => {
    const worker: TerminalMetadata = { ...agentTerminal(2, { working: false }), ledBy: "moth" }
    const { letters, inbox, streams, ids } = setup(workspaceOf(agentTerminal(1), worker))
    letters.push([
      letter({
        id: "worker-done",
        terminalId: "02",
        handle: "fox",
        content: { kind: "done", subject: "s", body: "b" },
      }),
      told(),
    ])
    await settle()
    expect(ids()).toEqual(["told-1"])
    inbox.readAll()
    await settle()
    expect(streams.asks.read).toHaveBeenCalledExactlyOnceWith(["told-1"])
  })

  it("reads all known tells in batches, beside the more urgent ask", async () => {
    const { letters, inbox, streams, ids } = setup(workspaceOf(agentTerminal(1)))
    const tells = Array.from({ length: 1001 }, (_, index) => told(`tell-${index}`))
    letters.push([letter(), ...tells])
    await settle()
    expect(ids()).toHaveLength(1002)
    expect(ids()[0]).toBe("letter-1")
    inbox.readAll()
    await settle()
    expect(streams.asks.read.mock.calls.map(([batch]) => batch.length)).toEqual([1000, 1])
    expect(streams.asks.answer).not.toHaveBeenCalled()
    // Submitted tells stay listed, answering, until the runner drops them.
    expect(ids()).toHaveLength(1002)
    expect(ids()).toContain("letter-1")
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
    const { inbox, letters, stop } = setup(ws(), both)
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

    letters.stream.return!()
    stop()
    expect(inbox.turns.getSnapshot()).toBeUndefined()
  })

  it("is undefined again when the iterator ends on its own", async () => {
    const feed = pushed<InboxLetter[]>()
    const streams = {
      asks: { watch: () => feed.stream, answer: async () => {}, read: async () => {} },
      detail: () => pushed<AgentDetail>().stream,
      answer: async () => {},
      send: async () => {},
      interrupt: async () => null,
      release: () => {},
      stop: () => {},
    } satisfies InboxStreams
    const inbox = createRunnerInbox(streams, createStore(noMail))
    inbox.bind({ workspace: createStore(ws()) })
    feed.push([])
    await settle()
    expect(inbox.turns.getSnapshot()).toEqual([])

    feed.finish()
    await settle()
    expect(inbox.turns.getSnapshot()).toBeUndefined()
  })

  it("hides a viewed terminal's rows at once, and keeps them hidden until a listing drops them", async () => {
    const { inbox, streams, letters, ids } = setup(ws(), bothFailed)
    await settle()
    let answered: (() => void) | undefined
    streams.asks.read.mockImplementationOnce(
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
    expect(streams.asks.read).toHaveBeenCalledExactlyOnceWith(["trouble:01:100"])

    // A listing that still holds it keeps it hidden, and sends nothing while it is on its way.
    letters.push([])
    await settle()
    expect(ids()).toEqual(["trouble:02:200"])
    expect(streams.asks.read).toHaveBeenCalledOnce()
    answered!()
    await settle()
    expect(inbox.turns.getSnapshot()?.map(({ id }) => id)).toEqual(["trouble:02:200"])
  })

  it("reads again only on the next listing or after a backoff, never on its own change", async () => {
    const { inbox, streams, letters } = setup(ws(), both)
    await settle()
    streams.asks.read.mockRejectedValueOnce(new Error("down"))
    inbox.readFinishes([finish])
    await settle()
    expect(streams.asks.read).toHaveBeenCalledTimes(1)
    expect(inbox.state.getSnapshot().failed).toEqual({})
    expect(inbox.state.getSnapshot().answering).toEqual({})

    // The backoff, 1 s then doubling, retries it.
    streams.asks.read.mockRejectedValueOnce(new Error("down"))
    await vi.advanceTimersByTimeAsync(retryMs)
    expect(streams.asks.read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(retryMs)
    expect(streams.asks.read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(retryMs)
    expect(streams.asks.read).toHaveBeenCalledTimes(3)

    // A listing that still holds a row not on its way sends it again.
    streams.asks.read.mockRejectedValueOnce(new Error("down"))
    inbox.readFinishes([{ context: "p/s", terminalId: "02" }])
    await settle()
    letters.push([])
    await settle()
    expect(streams.asks.read.mock.calls.map(([ids]) => ids)).toContainEqual(["update:02:200"])
  })

  it("reads a row that lands later when the terminal is read again", async () => {
    const { inbox, streams, letters } = setup(ws(), { "p/s": { "01": "done" } })
    await settle()
    inbox.readFinishes([finish])
    await settle()
    expect(streams.asks.read).toHaveBeenCalledTimes(1)

    const next = { ...turnLettersOf(ws(), done)[0]!, id: "later", at: 300 }
    letters.push([next])
    await settle()
    expect(inbox.turns.getSnapshot()?.map(({ id }) => id)).toEqual(["later"])
    inbox.readFinishes([finish])
    await settle()
    expect(streams.asks.read).toHaveBeenLastCalledWith(["later"])
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
    streams.asks.read.mockImplementationOnce(() => {
      throw new Error("sync")
    })
    inbox.readFinishes([finish])
    await settle()
    await vi.advanceTimersByTimeAsync(retryMs)

    expect(streams.asks.read).toHaveBeenCalledTimes(2)
  })

  it("shows a row of a terminal without a handle, and reads it with mark all read", async () => {
    const bare: TerminalMetadata = {
      ...agentTerminal(1, { working: false, lastTurn: turn({ reply: "a" }) }),
    }
    delete (bare as { handle?: string }).handle
    const ws2 = workspaceOf(bare)
    const { inbox, streams, letters, ids } = setup(ws2)
    letters.push([{ ...turnLettersOf(ws2, failed)[0]!, handle: "", id: "old-row", at: 50 }])
    await settle()
    expect(ids()).toEqual(["old-row"])

    inbox.readAll()
    await settle()
    expect(streams.asks.read).toHaveBeenCalledExactlyOnceWith(["old-row"])
  })
})
