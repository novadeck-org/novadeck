import type { ChatDialog } from "@novadeck/core/conversation"
import type { InboxBinding, InboxFinish, InboxUnread } from "@novadeck/core/inbox"
import {
  noMail,
  type AgentMessage,
  type MailState,
  type MessageThread,
} from "@novadeck/core/messages"
import { createTerminalState } from "@novadeck/core/state"
import { createStore } from "@novadeck/core/store"
import type { AgentStatus, AgentTurnEnd, TerminalMetadata, Workspace } from "@novadeck/core/types"
import type { AgentDetail, InboxLetter } from "@novadeck/protocol"
import { afterEach, beforeEach, vi } from "vitest"

import {
  createRunnerInbox,
  detailGraceMs,
  dialogMs,
  inboxItems,
  retryMs,
  settleMs,
  type Asked,
  type InboxStreams,
} from "./inbox"
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
  allowed: 3,
  held: true,
  messages: [message()],
  ...change,
})

const mailOf = (...threads: MessageThread[]): MailState => ({
  ...noMail,
  terminals: { "p/s/01": { handle: "moth", agent: true, threads } },
})

const inputs = (
  workspace: Workspace,
  more: Partial<Parameters<typeof inboxItems>[0]> = {},
): Parameters<typeof inboxItems>[0] => ({
  workspace,
  unread: {},
  mail: noMail,
  requests: {},
  letters: [],
  now: 10_000,
  ...more,
})

const done: InboxUnread = { "p/s": { "01": "done" } }
const failed: InboxUnread = { "p/s": { "01": "failed" } }

describe("The Inbox's items", () => {
  describe("a request", () => {
    const waiting = workspaceOf(
      agentTerminal(1, { working: true, attention: { kind: "permission", count: 1 } }),
    )

    it("comes from the oldest request, waiting since it was asked", () => {
      const items = inboxItems(
        inputs(waiting, {
          requests: { "01": [asked("r1", 4000), asked("r2", 5000), asked("r3", 6000)] },
          now: 5500,
        }),
      )

      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        id: "request:r1",
        at: 4000,
        stopped: true,
        seen: false,
        kind: "request",
        source: {
          projectId: "p",
          workspaceSessionId: "s",
          terminalId: "01",
          handle: "moth",
          agent: "claude",
          title: "Terminal 1",
          projectName: "App",
        },
      })
    })

    it("does not fall forward to a newer request while the oldest has no dialog yet", () => {
      const requests = { "01": [asked("r1", 4000, null), asked("r2", 4500)] }

      expect(inboxItems(inputs(waiting, { requests, now: 5000 }))).toEqual([])
      expect(inboxItems(inputs(waiting, { requests, now: 4000 + dialogMs }))[0]).toMatchObject({
        id: "request:r1",
      })
    })

    it("takes the terminal over an unread failed turn from before", () => {
      const both = workspaceOf(
        agentTerminal(1, {
          working: false,
          attention: { kind: "permission", count: 1 },
          lastTurn: turn({ outcome: "failed", error: "x" }),
        }),
      )
      const items = inboxItems(
        inputs(both, { unread: failed, requests: { "01": [asked("r1", 9000)] } }),
      )
      const pending = inboxItems(inputs(both, { unread: failed, requests: {} }))

      expect(items.map((item) => item.id)).toEqual(["request:r1"])
      expect(pending).toEqual([])
    })

    it("waits for a dialog a moment, then shows without one to be answered in the terminal", () => {
      const requests = { "01": [asked("r1", 4000, null)] }

      expect(inboxItems(inputs(waiting, { requests, now: 4000 + dialogMs - 1 }))).toEqual([])
      const [item] = inboxItems(inputs(waiting, { requests, now: 4000 + dialogMs }))
      expect(item).toMatchObject({ id: "request:r1", kind: "request", request: { dialog: null } })
    })

    it("is none once the agent no longer waits, whatever was last read", () => {
      const rested = workspaceOf(agentTerminal(1))

      expect(inboxItems(inputs(rested, { requests: { "01": [asked("r1", 1)] } }))).toEqual([])
    })

    it("keeps its identity and time across changes elsewhere", () => {
      const first = inboxItems(inputs(waiting, { requests: { "01": [asked("r1", 4000)] } }))
      const later = inboxItems(
        inputs(waiting, { requests: { "01": [asked("r1", 4000)] }, now: 99_000 }),
      )

      expect(later[0]!.id).toBe(first[0]!.id)
      expect(later[0]!.at).toBe(first[0]!.at)
    })
  })

  describe("a finished turn", () => {
    const rested = (end: Partial<AgentTurnEnd>) =>
      workspaceOf(agentTerminal(1, { working: false, lastTurn: turn(end) }))

    it("is an update while its mark is unread, with the reply and the files it wrote", () => {
      const [item] = inboxItems(
        inputs(
          rested({
            reply: "Done. Tests pass.",
            files: ["/work/app/src/a.ts", "/elsewhere/b.ts", "/work/application/c.ts"],
          }),
          { unread: done },
        ),
      )

      expect(item).toMatchObject({
        id: "update:01:100",
        at: 100,
        stopped: false,
        kind: "update",
        update: {
          type: "finished",
          subject: "Done. Tests pass.",
          reply: "Done. Tests pass.",
          files: ["src/a.ts", "/elsewhere/b.ts", "/work/application/c.ts"],
        },
      })
    })

    it("says murmur's gist first, and a plain line where there is no reply", () => {
      const [gist] = inboxItems(
        inputs(rested({ reply: "Long.", gist: "Fixed rounding" }), { unread: done }),
      )
      const [none] = inboxItems(inputs(rested({}), { unread: done }))

      expect(gist).toMatchObject({ update: { subject: "Fixed rounding", reply: "Long." } })
      expect(none).toMatchObject({ update: { subject: "Finished its turn", reply: "", files: [] } })
    })

    it("is none once read, or while the agent works again", () => {
      expect(inboxItems(inputs(rested({})))).toEqual([])
      const working = workspaceOf(
        agentTerminal(1, { working: true, lastTurn: turn({ reply: "old" }) }),
      )
      expect(inboxItems(inputs(working, { unread: done }))).toEqual([])
    })
  })

  describe("a failed turn", () => {
    const ended = (end: Partial<AgentTurnEnd>) =>
      workspaceOf(
        agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed", ...end }) }),
      )

    it("is trouble with its error while its mark is unread", () => {
      const [item] = inboxItems(inputs(ended({ error: "API Error: 529" }), { unread: failed }))

      expect(item).toMatchObject({
        id: "trouble:01:100",
        at: 100,
        stopped: true,
        kind: "trouble",
        trouble: { type: "failed", error: "API Error: 529" },
      })
    })

    it("has no error to show where its harness gave none", () => {
      const [item] = inboxItems(inputs(ended({}), { unread: failed }))

      expect(item).toMatchObject({ trouble: { type: "failed", error: null } })
    })

    it("goes once the person has viewed the terminal", () => {
      expect(inboxItems(inputs(ended({ error: "x" })))).toEqual([])
    })
  })

  describe("a usage limit", () => {
    const limited = (end: Partial<AgentTurnEnd>) =>
      workspaceOf(
        agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed", ...end }) }),
      )

    it("is trouble Novadeck can't resume, shown without an unread mark", () => {
      const [item] = inboxItems(
        inputs(limited({ error: "5-hour limit reached", limit: { minutes: 300, resetsAt: 9e12 } })),
      )

      expect(item).toMatchObject({
        id: "limit:01:100",
        stopped: true,
        trouble: {
          type: "limit",
          minutes: 300,
          resetsAt: 9e12,
          autoResume: null,
          evidence: [{ text: "5-hour limit reached", result: null, times: 1 }],
        },
      })
    })

    it("names a window of unknown length with 0 minutes and says so where no error came", () => {
      const [item] = inboxItems(inputs(limited({ limit: { minutes: null, resetsAt: 9e12 } })))

      expect(item).toMatchObject({
        trouble: { minutes: 0, evidence: [{ text: "Usage limit reached" }] },
      })
    })

    it("replaces the failure that came with it, and stays after the person looked", () => {
      const items = inboxItems(
        inputs(limited({ error: "x", limit: { minutes: 60, resetsAt: 9e12 } }), { unread: failed }),
      )

      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ trouble: { type: "limit" } })
    })

    it("goes with the agent's next turn", () => {
      const next = workspaceOf(agentTerminal(1, { working: true }))

      expect(inboxItems(inputs(next))).toEqual([])
    })
  })

  describe("a file the turn wrote", () => {
    const wrote = (directory: string, file: string) =>
      workspaceOf({
        ...agentTerminal(1, { working: false, lastTurn: turn({ files: [file] }) }),
        directory,
      })
    const withProject = (directory: string, file: string): string[] => {
      const workspace = wrote(directory, file)
      workspace.projects[0]!.directory = directory
      const [item] = inboxItems(inputs(workspace, { unread: done }))
      return item?.kind === "update" && item.update.type === "finished"
        ? [...item.update.files]
        : []
    }

    it("is relative to the project however its separators fall", () => {
      expect(withProject("C:/work/app", "C:\\work\\app\\src\\a.ts")).toEqual(["src\\a.ts"])
      expect(withProject("C:\\work\\app\\", "C:/work/app/src/a.ts")).toEqual(["src/a.ts"])
      expect(withProject("c:/work/app", "C:/Work/App/a.ts")).toEqual(["a.ts"])
      expect(withProject("/work/app", "/work/App/a.ts")).toEqual(["/work/App/a.ts"])
    })
  })

  describe("a held message", () => {
    const pair = workspaceOf(
      agentTerminal(1, { working: false }),
      agentTerminal(2, { working: false }, "codex"),
    )

    it("is an approve from the sender's terminal, from the oldest message held for release", () => {
      const held = thread({
        messages: [
          message({ id: "m0", state: "delivered", held: null, hop: 2 }),
          message({ id: "m1", hop: 3, sentAt: 50 }),
          message({ id: "m2", hop: 4, sentAt: 60, text: "Later" }),
        ],
      })
      const [item] = inboxItems(inputs(pair, { mail: mailOf(held) }))

      expect(item).toMatchObject({
        id: "held:th1",
        at: 50,
        stopped: true,
        kind: "held",
        source: { terminalId: "01", handle: "moth", agent: "claude" },
        held: {
          threadId: "th1",
          from: { handle: "moth", title: "Terminal 1" },
          to: { handle: "fox", title: "Terminal 2" },
          text: "Is the schema ready?",
          hop: 3,
          allowed: 3,
        },
      })
    })

    it("is one item for a thread both its terminals list", () => {
      const mail: MailState = {
        ...noMail,
        terminals: {
          "p/s/01": { handle: "moth", agent: true, threads: [thread()] },
          "p/s/02": { handle: "fox", agent: true, threads: [thread({ peer: "moth" })] },
        },
      }

      expect(inboxItems(inputs(pair, { mail }))).toHaveLength(1)
    })

    it("is not stopped while the sender's agent works", () => {
      const busy = workspaceOf(
        agentTerminal(1, { working: true }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const [item] = inboxItems(inputs(busy, { mail: mailOf(thread()) }))

      expect(item).toMatchObject({ stopped: false })
    })

    it("comes from the recipient's terminal where the sender is gone", () => {
      const alone = workspaceOf(agentTerminal(2, { working: false }, "codex"))
      const [item] = inboxItems(inputs(alone, { mail: mailOf(thread()) }))

      expect(item).toMatchObject({
        stopped: true,
        source: { terminalId: "02", agent: "codex" },
        held: { from: { handle: "moth", title: "moth" }, to: { title: "Terminal 2" } },
      })
    })

    it("is none while messaging is paused, and none once released", () => {
      const paused = thread({ messages: [message({ held: "paused" })] })

      expect(inboxItems(inputs(pair, { mail: mailOf(paused) }))).toEqual([])
      expect(inboxItems(inputs(pair, { mail: mailOf(thread({ held: false })) }))).toEqual([])
    })
  })

  describe("a terminal with several", () => {
    it("shows the most urgent: a request over a finished turn", () => {
      const both = workspaceOf(
        agentTerminal(1, {
          working: true,
          attention: { kind: "permission", count: 1 },
          lastTurn: turn({ reply: "old" }),
        }),
      )
      const items = inboxItems(inputs(both, { unread: done, requests: { "01": [asked("r1", 5)] } }))

      expect(items.map((item) => item.id)).toEqual(["request:r1"])
    })

    it("keeps a held thread beside the terminal's other item", () => {
      const pair = workspaceOf(
        agentTerminal(1, {
          working: false,
          lastTurn: turn({ outcome: "failed", error: "x" }),
        }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const items = inboxItems(inputs(pair, { unread: failed, mail: mailOf(thread()) }))

      expect(items.map((item) => item.id)).toEqual(["trouble:01:100", "held:th1"])
    })

    it("shows every held thread, the longest waiting first", () => {
      const both = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const mail: MailState = {
        ...noMail,
        terminals: {
          "p/s/01": {
            handle: "moth",
            agent: true,
            threads: [
              thread({ id: "newer", messages: [message({ sentAt: 90 })] }),
              thread({ id: "older", messages: [message({ sentAt: 20 })] }),
            ],
          },
        },
      }

      expect(inboxItems(inputs(both, { mail })).map((item) => item.id)).toEqual([
        "held:older",
        "held:newer",
      ])
    })
  })

  describe("the whole list", () => {
    it("orders by urgency, then by how long each waited, one per terminal", () => {
      const workspace = workspaceOf(
        agentTerminal(1, { working: false, lastTurn: turn({ at: 10, reply: "a" }) }),
        agentTerminal(2, { working: true, attention: { kind: "permission", count: 1 } }),
        agentTerminal(3, { working: false, lastTurn: turn({ at: 5, outcome: "failed" }) }),
        agentTerminal(4, { working: false }, "zsh"),
      )
      const items = inboxItems(
        inputs(workspace, {
          unread: { "p/s": { "01": "done", "03": "failed" } },
          requests: { "02": [asked("r1", 20)] },
        }),
      )

      expect(items.map((item) => item.id)).toEqual(["trouble:03:5", "request:r1", "update:01:10"])
    })

    it("holds nothing for a terminal that runs no agent, and never an ask, told or stuck", () => {
      const shell: TerminalMetadata = {
        id: "01",
        name: "Shell",
        directory: "/work/app",
        command: "zsh",
        process: "zsh",
        state: "idle",
      }
      const items = inboxItems(
        inputs(workspaceOf(shell, agentTerminal(2, { working: false, lastTurn: turn() })), {
          unread: { "p/s": { "01": "done", "02": "done" } },
        }),
      )

      expect(items.map((item) => item.id)).toEqual(["update:02:100"])
      expect(items.every((item) => item.kind !== "ask")).toBe(true)
    })
  })
})

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

const setup = (workspace: Workspace, unread: InboxUnread = {}, mail: MailState = noMail) => {
  const details: ReturnType<typeof pushed<AgentDetail>>[] = []
  const letters = pushed<InboxLetter[]>()
  const streams = {
    asks: {
      watch: vi.fn<InboxStreams["asks"]["watch"]>(() => letters.stream),
      answer: vi.fn<InboxStreams["asks"]["answer"]>(async () => {}),
      read: vi.fn<InboxStreams["asks"]["read"]>(async () => {}),
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
  const unreadStore = createStore(unread)
  const mailStore = createStore(mail)
  const read = vi.fn<(finishes: readonly InboxFinish[]) => void>((finishes) =>
    unreadStore.update((current) => {
      const next: Record<string, Record<string, "done" | "failed">> = {}
      for (const [context, ends] of Object.entries(current)) {
        const kept = Object.entries(ends).filter(
          ([id]) =>
            !finishes.some((finish) => finish.context === context && finish.terminalId === id),
        )
        if (kept.length > 0) next[context] = Object.fromEntries(kept)
      }
      return next
    }),
  )
  // The messages track a release or a stop in the mail state, as the runner backend's do.
  const releasing = (id: string) =>
    mailStore.update((current) => ({
      ...current,
      releasing: { ...current.releasing, [id]: "asked" },
    }))
  streams.release.mockImplementation(releasing)
  streams.stop.mockImplementation(releasing)
  const inbox = createRunnerInbox(streams, mailStore)
  const binding: InboxBinding = { workspace: workspaceStore, unread: unreadStore, read }
  const stop = inbox.bind(binding)
  const ids = () => inbox.state.getSnapshot().items.map((item) => item.id)
  return {
    inbox,
    streams,
    details,
    letters,
    workspaceStore,
    unreadStore,
    mailStore,
    read,
    stop,
    ids,
  }
}

const attention: AgentStatus = { working: true, attention: { kind: "permission", count: 1 } }

describe("The runner's Inbox", () => {
  describe("binding", () => {
    it("shows what the app's state holds, and empties when it stops", () => {
      const { inbox, stop, ids } = setup(
        workspaceOf(agentTerminal(1, { working: false, lastTurn: turn({ reply: "ok" }) })),
        done,
      )
      expect(ids()).toEqual(["update:01:100"])

      stop()

      expect(inbox.state.getSnapshot()).toEqual({ items: [], answering: {}, failed: {} })
    })

    it("follows the unread marks and the messages", () => {
      const pair = workspaceOf(
        agentTerminal(1, { working: false, lastTurn: turn() }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const { unreadStore, mailStore, ids } = setup(pair)
      expect(ids()).toEqual([])

      unreadStore.update(() => done)
      expect(ids()).toEqual(["update:01:100"])

      mailStore.update(() => mailOf(thread()))
      expect(ids()).toEqual(["held:th1", "update:01:100"])
      mailStore.update(() => mailOf(thread({ held: false })))
      expect(ids()).toEqual(["update:01:100"])
    })

    it("keeps an item's object while it reads the same", () => {
      const { inbox, unreadStore } = setup(
        workspaceOf(
          agentTerminal(1, { working: false, lastTurn: turn() }),
          agentTerminal(2, { working: false, lastTurn: turn({ at: 7 }) }),
        ),
        { "p/s": { "01": "done" } },
      )
      const [before] = inbox.state.getSnapshot().items
      unreadStore.update(() => ({ "p/s": { "01": "done", "02": "done" } }))

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
    const finished = () =>
      workspaceOf(
        agentTerminal(1, { working: false, lastTurn: turn({ reply: "a" }) }),
        agentTerminal(2, { working: false, lastTurn: turn({ reply: "b", at: 200 }) }),
      )
    const both: InboxUnread = { "p/s": { "01": "done", "02": "done" } }

    it("reads one through the app, which drops it", () => {
      const { inbox, read, ids } = setup(finished(), both)
      inbox.answer("update:01:100", { kind: "update", action: "read" })

      expect(read).toHaveBeenCalledWith([{ context: "p/s", terminalId: "01" }])
      expect(ids()).toEqual(["update:02:200"])
    })

    it("reads every update, leaving what waits on the person", () => {
      const waiting = workspaceOf(
        agentTerminal(1, { working: false, lastTurn: turn() }),
        agentTerminal(2, {
          working: false,
          lastTurn: turn({ outcome: "failed", at: 200, error: "x" }),
        }),
      )
      const { inbox, read, ids } = setup(waiting, { "p/s": { "01": "done", "02": "failed" } })
      inbox.readAll()

      expect(read).toHaveBeenCalledWith([{ context: "p/s", terminalId: "01" }])
      expect(ids()).toEqual(["trouble:02:200"])
    })

    it("marks an item seen, here only, until it goes", () => {
      const { inbox, unreadStore } = setup(finished(), both)
      inbox.see("update:01:100")
      expect(inbox.state.getSnapshot().items.map((item) => item.seen)).toEqual([true, false])

      unreadStore.update(() => ({ "p/s": { "02": "done" } }))
      unreadStore.update(() => both)
      expect(inbox.state.getSnapshot().items.map((item) => item.seen)).toEqual([false, false])
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

      expect(streams.send).toHaveBeenCalledWith(key, "continue")
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
      inbox.answer("trouble:01:100", {
        kind: "trouble",
        action: { type: "nudge", text: "Fix it." },
      })
      await settle()

      expect(streams.interrupt).not.toHaveBeenCalled()
      expect(streams.send).toHaveBeenCalledWith(key, "Fix it.")
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

  it("derives whether an ask waits from the agent's current working state", () => {
    for (const agent of ["claude", "codex", "agy"] as const) {
      for (const working of [true, false]) {
        const items = inboxItems(
          inputs(workspaceOf(agentTerminal(1, { working }, agent)), {
            letters: [letter({ agent })],
          }),
        )
        expect(items[0]).toMatchObject({ kind: "ask", stopped: !working, source: { agent } })
      }
    }
  })

  it("keeps the most urgent item and reveals a waiting letter once trouble clears", async () => {
    const { letters, unreadStore, inbox, ids } = setup(
      workspaceOf(agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed" }) })),
      failed,
    )
    letters.push([letter(), told()])
    await settle()
    expect(ids()).toEqual(["trouble:01:100"])
    unreadStore.update(() => ({}))
    expect(ids()).toEqual(["letter-1"])
    letters.push([told()])
    await settle()
    expect(inbox.state.getSnapshot().items[0]).toMatchObject({
      kind: "update",
      update: { type: "told" },
    })
  })

  it("keeps an unread tell after its agent exits, with its original attribution", () => {
    const exited: TerminalMetadata = {
      ...agentTerminal(1),
      state: "exited",
      exitCode: 0,
      signal: null,
    }
    const items = inboxItems(inputs(workspaceOf(exited), { letters: [letter(), told()] }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: "told-1",
      kind: "update",
      stopped: false,
      source: { agent: "claude", handle: "moth" },
      update: { type: "told" },
    })
    expect(inboxItems(inputs(workspaceOf(), { letters: [told()] }))).toEqual([])
  })

  it("keeps the old agent's tell beneath a new agent's ask until the tell is read", async () => {
    const { letters, inbox, streams, ids } = setup(
      workspaceOf(agentTerminal(1, { working: true }, "codex")),
    )
    const current = letter({ id: "new-ask", agent: "codex", sessionId: "new-session" })
    letters.push([letter(), told(), current])
    await settle()
    expect(ids()).toEqual(["new-ask"])
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
    const { letters, inbox, streams, read } = setup(workspaceOf(exited))
    letters.push([told()])
    await settle()
    inbox.readAll()
    expect(streams.asks.read).toHaveBeenCalledExactlyOnceWith(["told-1"])
    expect(read).not.toHaveBeenCalled()
  })

  it("keeps a current permission or plan ahead of an older stopped MCP ask", () => {
    for (const kind of ["permission", "plan"] as const) {
      const request = asked("gate", 8000)
      const waiting = workspaceOf(
        agentTerminal(1, { working: false, attention: { kind, count: 1 } }),
      )
      const items = inboxItems(
        inputs(waiting, {
          letters: [letter()],
          requests: { "01": [{ ...request, request: { ...request.request, kind } }] },
        }),
      )
      expect(items.map(({ id }) => id)).toEqual(["request:gate"])
    }
  })

  it("keeps a gate's unread dialog grace instead of showing an MCP ask", () => {
    const waiting = workspaceOf(agentTerminal(1, attention))
    for (const requests of [{}, { "01": [asked("gate", 9500, null)] }]) {
      expect(inboxItems(inputs(waiting, { letters: [letter()], requests }))).toEqual([])
    }
  })

  it("keeps the oldest of two stopped questions", () => {
    const question = asked("question", 8000)
    const waiting = workspaceOf(
      agentTerminal(1, { working: false, attention: { kind: "question", count: 1 } }),
    )
    const items = inboxItems(
      inputs(waiting, {
        letters: [letter()],
        requests: { "01": [{ ...question, request: { ...question.request, kind: "question" } }] },
      }),
    )
    expect(items.map(({ id }) => id)).toEqual(["letter-1"])
  })

  it("ignores letters for terminals outside their recorded ownership context", () => {
    for (const change of [
      { terminalId: "closed" },
      { projectId: "elsewhere" },
      { workspaceSessionId: "other" },
      { handle: "old-handle" },
      { agent: "codex" as const },
    ]) {
      expect(
        inboxItems(inputs(workspaceOf(agentTerminal(1)), { letters: [letter(change)] })),
      ).toEqual([])
    }
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

  it("keeps a hidden ask pending while its answer is unresolved", async () => {
    const { letters, inbox, streams, unreadStore, workspaceStore } = setup(
      workspaceOf(agentTerminal(1)),
    )
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
    unreadStore.update(() => failed)
    expect(inbox.state.getSnapshot().items.map(({ id }) => id)).toEqual(["trouble:01:100"])
    expect(inbox.state.getSnapshot().answering["letter-1"]).toBe(true)
    unreadStore.update(() => ({}))
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
    const { letters, inbox, streams, read } = setup(workspaceOf(agentTerminal(1)))
    letters.push([told()])
    await settle()
    inbox.answer("told-1", { kind: "update", action: "read" })
    expect(streams.asks.read).toHaveBeenCalledExactlyOnceWith(["told-1"])
    expect(read).not.toHaveBeenCalled()
  })

  it("reads all known tells in batches, including those hidden by more urgent items", async () => {
    const { letters, inbox, streams, ids } = setup(workspaceOf(agentTerminal(1)))
    const tells = Array.from({ length: 1001 }, (_, index) => told(`tell-${index}`))
    letters.push([letter(), ...tells])
    await settle()
    expect(ids()).toEqual(["letter-1"])
    inbox.readAll()
    expect(streams.asks.read.mock.calls.map(([batch]) => batch.length)).toEqual([1000, 1])
    expect(streams.asks.answer).not.toHaveBeenCalled()
    expect(ids()).toEqual(["letter-1"])
  })
})
