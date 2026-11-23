import type { ChatDialog } from "@novadeck/core/conversation"
import type { InboxBinding } from "@novadeck/core/inbox"
import { dialogMs, type Asked, type WrittenEntry } from "@novadeck/core/inbox/entries"
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
import { afterEach, beforeEach, expectTypeOf, vi } from "vitest"

import { describe, expect, it } from "../test"
import { channel } from "../testing/channel"
import { catchReports } from "../testing/reported"
import { createRunnerInbox, detailGraceMs, retryMs, settleMs, type InboxStreams } from "./inbox"

// The terminals these tests have, by handle: 01 is moth, 02 is fox.
const idOf = (handle: string): string => ({ moth: "01", fox: "02", owl: "03", crow: "04" })[handle]!

const agentParty = (handle: string): MessageParty => ({
  kind: "agent",
  terminalId: idOf(handle),
  handle,
  agent: null,
})

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
    askedAt: 0,
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
  terminals: { "p/s/01": { terminalId: "01", handle: "moth", agent: true, threads } },
})

// The finished turns the tests state, by session context then terminal: each stands for the
// stored entry of that terminal's current end, as the runner lists it.
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
  prompts: [],
})

const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => vi.useFakeTimers({ now: 10_000 }))
afterEach(() => vi.useRealTimers())

const setup = (
  workspace: Workspace,
  unread: Marks = {},
  messages: MessagesState = noMessages,
  options: Parameters<typeof createRunnerInbox>[2] = {},
  more: Partial<Pick<InboxStreams, "takeBack" | "gate">> = {},
) => {
  const details: ReturnType<typeof channel<AgentDetail>>[] = []
  const feed = channel<InboxEntry[]>()
  // What the runner lists: the asks and tells a test pushes, and the turn entries its marks
  // stand for, which reading removes.
  let others: InboxEntry[] = []
  let turnEntries: InboxEntry[] = []
  const publish = () => feed.push([...others, ...turnEntries])
  const entries = {
    stream: feed.iterator,
    returned: feed.returned,
    end: feed.end,
    push: (list: InboxEntry[]) => {
      others = list
      publish()
    },
  }
  const streams = {
    inbox: {
      watch: vi.fn<InboxStreams["inbox"]["watch"]>(() => feed.iterator),
      answer: vi.fn<InboxStreams["inbox"]["answer"]>(async () => {}),
      answerQuestions: vi.fn<InboxStreams["inbox"]["answerQuestions"]>(async () => {}),
      dismiss: vi.fn<InboxStreams["inbox"]["dismiss"]>(async () => {}),
      read: vi.fn<InboxStreams["inbox"]["read"]>(async (ids) => {
        const gone = ({ id, content }: InboxEntry) => content.kind === "turn" && ids.includes(id)
        if (!turnEntries.some(gone) && !others.some(gone)) return
        turnEntries = turnEntries.filter((each) => !gone(each))
        others = others.filter((each) => !gone(each))
        publish()
      }),
    },
    detail: vi.fn<InboxStreams["detail"]>(() => {
      const next = channel<AgentDetail>()
      details.push(next)
      return next.iterator
    }),
    answer: vi.fn<InboxStreams["answer"]>(async () => {}),
    send: vi.fn<InboxStreams["send"]>(async () => {}),
    interrupt: vi.fn<InboxStreams["interrupt"]>(async () => null),
    release: vi.fn<InboxStreams["release"]>(),
    stop: vi.fn<InboxStreams["stop"]>(),
    ...more,
  }
  const workspaceStore = createStore(workspace)
  const messagesStore = createStore(messages)
  // The runner now lists these marks' entries.
  const marks = (next: Marks): void => {
    turnEntries = turnEntriesOf(workspaceStore.getSnapshot(), next)
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
  const inbox = createRunnerInbox(streams, messagesStore, options)
  const binding: InboxBinding = { workspace: workspaceStore }
  if (Object.keys(unread).length > 0) marks(unread)
  const stop = inbox.bind(binding)
  // The entries that are still open; the resolved ones stay listed beside them, as history.
  const ids = () =>
    inbox.state
      .getSnapshot()
      .items.filter((item) => !item.settled)
      .map((item) => item.id)
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
            terminalId: "02",
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
      expect(details[0]!.returned()).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(details[0]!.returned()).toBe(1)
    })

    it("keeps the detail open when a request comes within the grace", async () => {
      const { streams, details, workspaceStore } = setup(waiting())
      workspaceStore.update(() => workspaceOf(agentTerminal(1)))
      await vi.advanceTimersByTimeAsync(detailGraceMs - 1000)
      workspaceStore.update(() => waiting())
      await vi.advanceTimersByTimeAsync(detailGraceMs * 2)

      expect(streams.detail).toHaveBeenCalledTimes(1)
      expect(details[0]!.returned()).toBe(0)
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

      details[1]!.end()
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
      expect(details[0]!.returned()).toBeGreaterThan(0)
    })

    it("stops reading once unbound", async () => {
      const { details, stop, streams } = setup(waiting())
      stop()
      await settle()
      await vi.advanceTimersByTimeAsync(detailGraceMs * 3)

      expect(details[0]!.returned()).toBe(1)
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

  describe("history", () => {
    const waiting = () => workspaceOf(agentTerminal(1, attention))
    const withRequest = async (options: Parameters<typeof setup>[3] = {}) => {
      const set = setup(waiting(), {}, noMessages, options)
      set.entries.push([])
      set.details[0]!.push(detailOf(asked("r1", 9000)))
      await settle()
      return set
    }

    it("keeps a dialog answered here as a resolved entry, with the person's answer, and saves it", async () => {
      const saveHistory = vi.fn<(saved: readonly string[]) => void>()
      const { inbox, workspaceStore } = await withRequest({ saveHistory })
      inbox.answer("request:r1", {
        kind: "request",
        answer: { type: "choice", dialog: "d1", option: "yes", text: "go on" },
      })
      workspaceStore.update(() => workspaceOf(agentTerminal(1, { working: true })))
      await settle()
      expect(inbox.state.getSnapshot().items).toMatchObject([
        { id: "request:r1", stopped: false, settled: { how: "answered", answer: "Yes: go on" } },
      ])
      expect(inbox.state.getSnapshot().answering).toEqual({})
      const saved = saveHistory.mock.calls.at(-1)![0].map((text) => JSON.parse(text))
      expect(saved).toMatchObject([{ id: "request:r1", settled: { how: "answered" } }])
    })

    it("keeps a dialog the person answered in the terminal, and one that ended unanswered", async () => {
      const first = await withRequest()
      first.workspaceStore.update(() => workspaceOf(agentTerminal(1, { working: true })))
      await settle()
      expect(first.inbox.state.getSnapshot().items[0]?.settled).toMatchObject({ how: "terminal" })
      const second = await withRequest()
      second.workspaceStore.update(() => workspaceOf(agentTerminal(1)))
      await settle()
      expect(second.inbox.state.getSnapshot().items[0]?.settled).toMatchObject({ how: "gone" })
    })

    it("brings back what the runner kept, and drops what it can't read", async () => {
      const saveHistory = vi.fn<(saved: readonly string[]) => void>()
      const first = await withRequest({ saveHistory })
      first.workspaceStore.update(() => workspaceOf(agentTerminal(1)))
      await settle()
      const kept = saveHistory.mock.calls.at(-1)![0]
      const next = setup(workspaceOf(agentTerminal(1)), {}, noMessages, {
        history: [...kept, "not json"],
      })
      next.entries.push([])
      await settle()
      expect(next.inbox.state.getSnapshot().items).toMatchObject([
        { id: "request:r1", settled: { how: "gone" } },
      ])
    })

    it("makes no entry of an ask its agent withdrew, and saves none", async () => {
      const saveHistory = vi.fn<(saved: readonly string[]) => void>()
      const { entries, inbox } = setup(workspaceOf(agentTerminal(1)), {}, noMessages, {
        saveHistory,
      })
      entries.push([entry()])
      await settle()
      expect(inbox.state.getSnapshot().items).toHaveLength(1)
      entries.push([])
      await settle()
      expect(inbox.state.getSnapshot().items).toEqual([])
      expect(saveHistory.mock.calls.every(([saved]) => saved.length === 0)).toBe(true)
    })

    it("takes no entry to have ended while the connection is down, nor until the streams list again", async () => {
      const status = channel<{ state: string }>()
      const { entries, inbox, details, workspaceStore } = setup(
        workspaceOf(agentTerminal(1, attention)),
        {},
        noMessages,
        { status: () => status.iterator },
      )
      entries.push([])
      details[0]!.push(detailOf(asked("r1", 9000)))
      status.push({ state: "connected" })
      await settle()
      expect(inbox.state.getSnapshot().items).toHaveLength(1)
      status.push({ state: "reconnecting" })
      await settle()
      // The dialog is gone from what the app sees while the streams reset: nothing has ended.
      workspaceStore.update(() => workspaceOf(agentTerminal(1)))
      await settle()
      expect(inbox.state.getSnapshot().items).toEqual([])
      workspaceStore.update(() => workspaceOf(agentTerminal(1, attention)))
      status.push({ state: "connected" })
      entries.push([])
      await settle()
      details[0]!.push(detailOf(asked("r1", 9000)))
      await settle()
      expect(inbox.state.getSnapshot().items.map((entry) => entry.settled)).toEqual([undefined])
    })

    it("does not take an entry to have ended while the runner's entries are out", async () => {
      const { entries, inbox } = setup(workspaceOf(agentTerminal(1)))
      entries.push([entry()])
      await settle()
      expect(inbox.state.getSnapshot().items).toHaveLength(1)
      entries.end()
      await settle()
      // Its entry is gone with its listing, not resolved.
      expect(inbox.state.getSnapshot().items).toEqual([])
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

    it("resolves a failed turn that is no longer the agent's current end, and reads its stored entry", async () => {
      const ws = workspaceOf(
        agentTerminal(1, {
          working: false,
          lastTurn: turn({ outcome: "failed", at: 200, error: "x" }),
        }),
      )
      const { inbox, streams, entries } = setup(ws, { "p/s": { "01": "failed" } })
      await settle()
      const older = {
        ...turnEntriesOf(ws, { "p/s": { "01": "failed" } })[0]!,
        id: "old-row",
        at: 50,
      }
      entries.push([older])
      await settle()
      expect(
        inbox.state
          .getSnapshot()
          .items.map(({ id }) => id)
          .toSorted(),
      ).toEqual(["old-row", "trouble:01:200"])
      const shown = inbox.state.getSnapshot().items
      // The current one waits; the old one ended when its agent went on.
      expect(shown.find(({ id }) => id === "trouble:01:200")?.settled).toBeUndefined()
      expect(shown.find(({ id }) => id === "old-row")?.settled).toMatchObject({ how: "worked" })
      expect(streams.inbox.read.mock.calls.map(([batch]) => batch)).toEqual([["old-row"]])
    })

    it("marks an item seen, here only, until it goes", async () => {
      const { inbox, entries } = setup(two())
      entries.push([report("done-1"), report("done-2", fox)])
      await settle()
      inbox.see("done-1")
      const seen = () =>
        inbox.state
          .getSnapshot()
          .items.filter((item) => !item.settled)
          .toSorted((a, b) => a.id.localeCompare(b.id))
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

    it("reads the failed entry once its nudge was sent, with nothing left answering", async () => {
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

    it("nudges no failed entry while its agent works, and interrupts nothing", async () => {
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

// `request_permit` answers at once, so an agent's turn ends while the gate's card waits on the
// person: the runner's summary counts each card as a request asked without waiting.
describe("The shipping gate's cards", () => {
  const ended = (count: number) =>
    workspaceOf(
      agentTerminal(1, {
        working: false,
        attention: { kind: "permission", count, detached: true },
        lastTurn: turn(),
      }),
    )
  const cards = (...titles: string[]): AgentDetail => {
    const base = detailOf()
    return {
      ...base,
      requests: titles.map((title, index) => ({
        ref: `held-c${index + 1}`,
        actor: "rootrootrootroot",
        kind: "permission" as const,
        tool: "request_permit",
        subject: title,
        choices: ["Allow", "Deny"],
        dialog: {
          type: "choices" as const,
          id: `permit-c${index + 1}`,
          title,
          detail: "PR #1189, on main",
          options: [
            { id: "allow", label: "Allow", text: null },
            { id: "deny", label: "Deny", text: null },
          ],
        },
        answered: false,
        askedAt: 9000 + index,
        detached: true as const,
      })),
    }
  }

  it("lists each open card of an agent whose turn ended, and answers one through its dialog", async () => {
    const { details, inbox, streams, ids } = setup(ended(2))
    expect(details).toHaveLength(1)
    details[0]!.push(cards("Merge PR #1189?", "Merge PR #1191?"))
    await settle()

    expect(ids().toSorted()).toEqual(["request:held-c1", "request:held-c2"])
    const answer = { type: "choice", dialog: "permit-c1", option: "allow" } as const
    inbox.answer("request:held-c1", { kind: "request", answer })
    expect(streams.answer).toHaveBeenCalledWith(
      { projectId: "p", workspaceSessionId: "s", terminalId: "01" },
      "held-c1",
      answer,
    )
  })

  it("drops a card once the runner no longer holds it: answered, given by words, or closed", async () => {
    const { details, workspaceStore, ids } = setup(ended(2))
    details[0]!.push(cards("Merge PR #1189?", "Merge PR #1191?"))
    await settle()

    details[0]!.push(cards("Merge PR #1189?"))
    workspaceStore.update(() => ended(1))
    await settle()
    expect(ids()).toEqual(["request:held-c1"])

    workspaceStore.update(() => workspaceOf(agentTerminal(1, { working: false, lastTurn: turn() })))
    await settle()
    expect(ids()).toEqual([])
  })
})

describe("The shipping gate's standing permits", () => {
  // A resting agent whose summary says a permit stands there: only its detail lists them.
  const resting = () => workspaceOf(agentTerminal(1, { working: false, permits: 1 }))
  const standing = (...ids: string[]): AgentDetail => ({
    ...detailOf(),
    permits: ids.map((id) => ({
      id,
      title: "Merge PR #1190 into main",
      quote: id === "p1" ? "merge it" : null,
      givenAt: 9000,
      until: 9000 + 12 * 60 * 60_000,
      usedAt: null,
    })),
  })
  const take = () => vi.fn<NonNullable<InboxStreams["takeBack"]>>(async () => ({ ended: true }))
  const gated = (open = true) => createStore(open)

  it("follows no resting agent's detail where its summary says no permit stands", async () => {
    const { details } = setup(
      workspaceOf(agentTerminal(1)),
      {},
      noMessages,
      {},
      { takeBack: take(), gate: gated() },
    )
    await settle()
    expect(details).toHaveLength(0)
  })

  it("follows a resting agent's detail while the gate is on, and lists each permit", async () => {
    const takeBack = take()
    const { details, inbox, ids } = setup(
      resting(),
      {},
      noMessages,
      {},
      { takeBack, gate: gated() },
    )
    await settle()
    expect(details).toHaveLength(1)

    details[0]!.push(standing("p1", "p2"))
    await settle()

    expect(ids().toSorted()).toEqual(["permit:01:p1", "permit:01:p2"])
    expect(inbox.state.getSnapshot().items.find(({ id }) => id === "permit:01:p1")).toMatchObject({
      kind: "permit",
      at: 9000,
      permit: { quote: "merge it", usedAt: null },
    })
  })

  it("resolves a permit once the detail stops listing it", async () => {
    const { details, inbox, ids, entries } = setup(
      resting(),
      {},
      noMessages,
      {},
      { takeBack: take(), gate: gated() },
    )
    entries.push([])
    await settle()
    details[0]!.push(standing("p1"))
    await settle()
    details[0]!.push(standing())
    await settle()

    expect(ids()).toEqual([])
    expect(inbox.state.getSnapshot().items[0]).toMatchObject({
      id: "permit:01:p1",
      settled: { how: "lapsed" },
    })
  })

  it("resolves a permit the chat took back as taken back, and one whose call failed as lapsed", async () => {
    const { details, inbox, entries } = setup(
      resting(),
      {},
      noMessages,
      {},
      { takeBack: take(), gate: gated() },
    )
    entries.push([])
    await settle()
    details[0]!.push(standing("p1", "p2"))
    await settle()
    inbox.takenBack("01", "p1")
    inbox.takenBack("01", "p2")
    inbox.takenBack("01", "p2", true)
    details[0]!.push(standing())
    await settle()

    const settled = Object.fromEntries(
      inbox.state.getSnapshot().items.map(({ id, settled: how }) => [id, how?.how]),
    )
    expect(settled).toEqual({ "permit:01:p1": "takenBack", "permit:01:p2": "lapsed" })
  })

  it("shows none and follows no detail where the runner can't take one back, or the gate is off", async () => {
    const without = setup(resting(), {}, noMessages, {}, { gate: gated() })
    const off = setup(resting(), {}, noMessages, {}, { takeBack: take(), gate: gated(false) })
    await settle()

    expect(without.details).toHaveLength(0)
    expect(off.details).toHaveLength(0)
    expect(without.ids()).toEqual([])
    expect(off.ids()).toEqual([])
  })

  it("follows the detail from when the gate is turned on, and shows no permit once it is off", async () => {
    const gate = gated(false)
    const { details, ids } = setup(resting(), {}, noMessages, {}, { takeBack: take(), gate })
    await settle()
    expect(details).toHaveLength(0)

    gate.update(() => true)
    await settle()
    details[0]!.push(standing("p1"))
    await settle()
    expect(ids()).toEqual(["permit:01:p1"])

    gate.update(() => false)
    await settle()
    expect(ids()).toEqual([])
  })

  describe("taking one back", () => {
    const listed = async (takeBack: ReturnType<typeof take>) => {
      const made = setup(resting(), {}, noMessages, {}, { takeBack, gate: gated() })
      made.entries.push([])
      await settle()
      made.details[0]!.push(standing("p1"))
      await settle()
      return made
    }
    const press = (inbox: Awaited<ReturnType<typeof listed>>["inbox"]) =>
      inbox.answer("permit:01:p1", { kind: "permit", action: "take-back" })

    it("asks the runner for that permit, and notes it was the person who ended it", async () => {
      const takeBack = take()
      const { inbox, details } = await listed(takeBack)
      press(inbox)
      await settle()
      expect(takeBack).toHaveBeenCalledWith("01", "p1")
      expect(inbox.state.getSnapshot().answering).toEqual({ "permit:01:p1": true })

      details[0]!.push(standing())
      await settle()
      expect(inbox.state.getSnapshot().items[0]).toMatchObject({ settled: { how: "takenBack" } })
    })

    it("says so on the entry when the call is refused, and the permit still stands", async () => {
      const takeBack = take()
      takeBack.mockRejectedValueOnce(new Error("offline"))
      const { inbox, ids } = await listed(takeBack)
      press(inbox)
      await settle()

      expect(ids()).toEqual(["permit:01:p1"])
      expect(inbox.state.getSnapshot()).toMatchObject({
        answering: {},
        failed: { "permit:01:p1": "Couldn't take it back. Try again." },
      })
    })

    it("says so, too, when the runner answers that none stood while the entry still shows", async () => {
      const takeBack = take()
      takeBack.mockResolvedValueOnce({ ended: false })
      const { inbox } = await listed(takeBack)
      press(inbox)
      await settle()

      expect(inbox.state.getSnapshot().failed).toEqual({ "permit:01:p1": "It had already ended." })
    })
  })
})

describe("Inbox entries", () => {
  it("are core's written entries once their finished turns and session id are left out", () => {
    type Written = Omit<InboxEntry, "sessionId" | "content"> & {
      readonly content: Exclude<InboxEntry["content"], { kind: "turn" }>
    }
    // Each kind of content with its fields, so a field added to one side's kind shows.
    type Kinds<Content> = Content extends { kind: infer Kind } ? [Kind, keyof Content] : never
    expectTypeOf<Written>().toExtend<WrittenEntry>()
    expectTypeOf<keyof Written>().toEqualTypeOf<keyof WrittenEntry>()
    expectTypeOf<Kinds<Written["content"]>>().toEqualTypeOf<Kinds<WrittenEntry["content"]>>()
  })

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
    expect(entries.returned()).toBe(1)
    expect(ids()).toEqual([])
    entries.push([entry()])
    await settle()
    expect(ids()).toEqual([])
  })

  it("come back once the backend starts again, bound again or still bound", async () => {
    const { inbox, streams, entries, workspaceStore, stop, ids } = setup(
      workspaceOf(agentTerminal(1)),
    )
    entries.push([entry()])
    await settle()
    expect(ids()).toEqual(["entry-1"])
    // As React's StrictMode runs the effects in development: the backend stops, the Inbox is
    // unbound, then the backend starts and the Inbox is bound again.
    inbox.end()
    stop()
    inbox.follow()
    const again = inbox.bind({ workspace: workspaceStore })
    entries.push([entry(), told()])
    await settle()
    expect(ids().toSorted()).toEqual(["entry-1", "told-1"])
    // A stop and start while it stays bound opens the entries again too.
    inbox.end()
    inbox.follow()
    expect(streams.inbox.watch).toHaveBeenCalledTimes(3)
    entries.push([told()])
    await settle()
    expect(ids()).toEqual(["told-1"])
    again()
  })

  it("keep coming after a listing whose readers throw, which is reported", async () => {
    const { inbox, entries, ids } = setup(workspaceOf(agentTerminal(1)))
    const { reported, restore } = catchReports()
    const broken = new Error("A reader broke.")
    let breaks = true
    const unsubscribe = inbox.state.subscribe(() => {
      if (!breaks) return
      breaks = false
      throw broken
    })
    try {
      entries.push([entry()])
      await settle()
      entries.push([entry(), told()])
      await settle()
    } finally {
      unsubscribe()
      restore()
    }
    expect(reported).toEqual([broken])
    expect(ids().toSorted()).toEqual(["entry-1", "told-1"])
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
    expect(inbox.state.getSnapshot().items.find(({ id }) => id === "told-1")).toMatchObject({
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
    expect(inbox.state.getSnapshot().items.find(({ id }) => id === "told-1")).toMatchObject({
      id: "told-1",
      source: { agent: "claude" },
    })
    inbox.answer("told-1", { kind: "update", action: "read" })
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

  it("sends the answers to several questions by their own procedure", async () => {
    const { entries, inbox, streams } = setup(workspaceOf(agentTerminal(1)))
    entries.push([entry()])
    await settle()
    inbox.answer("entry-1", {
      kind: "ask",
      answer: {
        type: "questions",
        answers: [
          { options: [1], text: "" },
          { options: [], text: "Neither" },
        ],
      },
    })
    expect(streams.inbox.answerQuestions).toHaveBeenCalledExactlyOnceWith("entry-1", [
      { options: [1], text: "" },
      { options: [], text: "Neither" },
    ])
    expect(streams.inbox.answer).not.toHaveBeenCalled()
  })

  it("keeps an ask pending beside trouble while its answer is unresolved", async () => {
    const { entries, inbox, streams, marks, workspaceStore, ids } = setup(
      workspaceOf(agentTerminal(1)),
    )
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
    expect(ids()).toEqual(["entry-1"])
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
    await settle()
    expect(ids()).toEqual(["done-1"])
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
    expect(ids()).toEqual([])
    expect(inbox.state.getSnapshot().items[0]).toMatchObject({
      id: "entry-1",
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
})

describe("Turn entries", () => {
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
    const feed = channel<InboxEntry[]>()
    const streams = {
      inbox: {
        watch: () => feed.iterator,
        answer: async () => {},
        answerQuestions: async () => {},
        read: async () => {},
        dismiss: async () => {},
      },
      detail: () => channel<AgentDetail>().iterator,
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

    feed.end()
    await settle()
    expect(inbox.turns.getSnapshot()).toBeUndefined()
  })

  it("hides a viewed terminal's entries at once, and keeps them hidden until a listing drops them", async () => {
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

    // A listing that still holds an entry not on its way sends it again.
    streams.inbox.read.mockRejectedValueOnce(new Error("down"))
    inbox.readFinishes([{ context: "p/s", terminalId: "02" }])
    await settle()
    entries.push([])
    await settle()
    expect(streams.inbox.read.mock.calls.map(([ids]) => ids)).toContainEqual(["update:02:200"])
  })

  it("reads an entry that lands later when the terminal is read again", async () => {
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

  it("keeps entries hidden under a lead in turns, and out of the items", async () => {
    const worker: TerminalMetadata = {
      ...agentTerminal(2, { working: false, lastTurn: turn({ at: 200 }) }),
      ledBy: "01",
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

  it("shows an entry of a terminal without a handle, and reads it once it is resolved", async () => {
    const bare: TerminalMetadata = {
      ...agentTerminal(1, { working: false, lastTurn: turn({ reply: "a" }) }),
    }
    delete (bare as { handle?: string }).handle
    const ws2 = workspaceOf(bare)
    const { inbox, streams, entries, ids } = setup(ws2)
    entries.push([{ ...turnEntriesOf(ws2, failed)[0]!, handle: "", id: "old-row", at: 50 }])
    await settle()
    expect(ids()).toEqual([])
    expect(inbox.state.getSnapshot().items).toMatchObject([
      { id: "old-row", settled: { how: "worked" } },
    ])
    expect(streams.inbox.read).toHaveBeenCalledExactlyOnceWith(["old-row"])
  })
})
