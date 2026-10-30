import { longHoldMs } from "@novadeck/protocol"

import type { ChatDialog } from "../conversation"
import type { InboxTurn } from "../inbox"
import {
  noMessages,
  type AgentMessage,
  type MessageParty,
  type MessagesState,
  type MessageThread,
  type TerminalThreads,
} from "../messages"
import { createTerminalState } from "../state"
import { describe, expect, it } from "../test"
import type { AgentStatus, AgentTurnEnd, TerminalMetadata, Workspace } from "../types"
import {
  dialogMs,
  inboxRows,
  leadHearsOf,
  type Asked,
  type InboxInputs,
  type WrittenEntry,
} from "./rows"

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

// The marks these tests state, by session context then terminal, stand for the stored row of
// that terminal's current end: the row the runner keeps for it.
type Marks = Readonly<Record<string, Readonly<Record<string, "done" | "failed">>>>

const rowsOf = (workspace: Workspace, marks: Marks): InboxTurn[] =>
  workspace.projects.flatMap((project) =>
    project.history.flatMap((session) =>
      session.state.roster.terminals.flatMap((terminal): InboxTurn[] => {
        const mark = marks[`${project.id}/${session.id}`]?.[terminal.id]
        const end = terminal.state === "running" ? terminal.agent?.lastTurn : undefined
        if (!mark || !end) return []
        return [
          {
            id: `${mark === "done" ? "update" : "trouble"}:${terminal.id}:${end.at}`,
            projectId: project.id,
            workspaceSessionId: session.id,
            terminalId: terminal.id,
            handle: terminal.handle ?? "",
            agent: terminal.process as InboxTurn["agent"],
            at: end.at,
            outcome: mark === "done" ? "completed" : "failed",
            reply: end.reply ?? null,
            error: end.error ?? null,
            files: end.files ?? [],
          },
        ]
      }),
    ),
  )

const inputs = (
  workspace: Workspace,
  { unread = {}, ...more }: Partial<InboxInputs> & { unread?: Marks } = {},
): InboxInputs => ({
  workspace,
  turns: rowsOf(workspace, unread),
  messages: noMessages,
  requests: {},
  entries: [],
  now: 10_000,
  longHoldMs,
  ...more,
})

const entry = (change: Partial<WrittenEntry> = {}): WrittenEntry => ({
  id: "entry-1",
  terminalId: "01",
  projectId: "p",
  workspaceSessionId: "s",
  agent: "claude",
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

const done: Marks = { "p/s": { "01": "done" } }
const failed: Marks = { "p/s": { "01": "failed" } }

describe("The Inbox's rows", () => {
  describe("a request", () => {
    const waiting = workspaceOf(
      agentTerminal(1, { working: true, attention: { kind: "permission", count: 1 } }),
    )

    it("comes from the oldest request, waiting since it was asked", () => {
      const rows = inboxRows(
        inputs(waiting, {
          requests: { "01": [asked("r1", 4000), asked("r2", 5000), asked("r3", 6000)] },
          now: 5500,
        }),
      )

      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
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

      expect(inboxRows(inputs(waiting, { requests, now: 5000 }))).toEqual([])
      expect(inboxRows(inputs(waiting, { requests, now: 4000 + dialogMs }))[0]).toMatchObject({
        id: "request:r1",
      })
    })

    it("stands beside an unread failed turn from before, which shows while it waits too", () => {
      const both = workspaceOf(
        agentTerminal(1, {
          working: false,
          attention: { kind: "permission", count: 1 },
          lastTurn: turn({ outcome: "failed", error: "x" }),
        }),
      )
      const rows = inboxRows(
        inputs(both, { unread: failed, requests: { "01": [asked("r1", 9000)] } }),
      )
      const pending = inboxRows(inputs(both, { unread: failed, requests: {} }))

      // A subagent's or the screen's request can stand after the root's Stop.
      expect(rows.map((row) => row.id).toSorted()).toEqual(["request:r1", "trouble:01:100"])
      expect(pending.map((row) => row.id)).toEqual(["trouble:01:100"])
    })

    it("waits for a dialog a moment, then shows without one to be answered in the terminal", () => {
      const requests = { "01": [asked("r1", 4000, null)] }

      expect(inboxRows(inputs(waiting, { requests, now: 4000 + dialogMs - 1 }))).toEqual([])
      const [row] = inboxRows(inputs(waiting, { requests, now: 4000 + dialogMs }))
      expect(row).toMatchObject({ id: "request:r1", kind: "request", request: { dialog: null } })
    })

    it("is none once the agent no longer waits, whatever was last read", () => {
      const rested = workspaceOf(agentTerminal(1))

      expect(inboxRows(inputs(rested, { requests: { "01": [asked("r1", 1)] } }))).toEqual([])
    })

    it("keeps its identity and time across changes elsewhere", () => {
      const first = inboxRows(inputs(waiting, { requests: { "01": [asked("r1", 4000)] } }))
      const later = inboxRows(
        inputs(waiting, { requests: { "01": [asked("r1", 4000)] }, now: 99_000 }),
      )

      expect(later[0]!.id).toBe(first[0]!.id)
      expect(later[0]!.at).toBe(first[0]!.at)
    })
  })

  describe("a completed turn", () => {
    const rested = (end: Partial<AgentTurnEnd>) =>
      workspaceOf(agentTerminal(1, { working: false, lastTurn: turn(end) }))

    it("makes no row, stored or not: it only marks its tab", () => {
      expect(inboxRows(inputs(rested({ reply: "Done. Tests pass." }), { unread: done }))).toEqual(
        [],
      )
      expect(inboxRows(inputs(rested({})))).toEqual([])
    })

    it("leaves a failed row of the same terminal as it was", () => {
      const ws = rested({ outcome: "failed", error: "x" })
      expect(inboxRows(inputs(ws, { unread: failed }))).toMatchObject([
        { id: "trouble:01:100", kind: "trouble" },
      ])
    })
  })

  describe("a done report", () => {
    const report = (change: Partial<WrittenEntry> = {}): WrittenEntry =>
      entry({
        id: "entry:done-1",
        content: { kind: "done", subject: "Search rebuilt", body: "All 412 pages." },
        ...change,
      })
    const worker = (): TerminalMetadata => ({ ...agentTerminal(2), ledBy: "moth" })

    it("is an update of its terminal that the person reads, not stopping the agent", () => {
      const rows = inboxRows(inputs(workspaceOf(agentTerminal(1)), { entries: [report()] }))
      expect(rows).toMatchObject([
        {
          id: "entry:done-1",
          kind: "update",
          stopped: false,
          source: { terminalId: "01", handle: "moth", agent: "claude" },
          update: { type: "done", subject: "Search rebuilt", body: "All 412 pages." },
        },
      ])
    })

    it("is kept for a terminal without a handle, which the demo stores as an empty one", () => {
      const { handle: _handle, ...bare } = agentTerminal(1)
      const rows = inboxRows(inputs(workspaceOf(bare), { entries: [report({ handle: "" })] }))
      expect(rows).toMatchObject([{ id: "entry:done-1", update: { type: "done" } }])
    })

    it("stays after its agent exits, like a tell", () => {
      const exited: TerminalMetadata = {
        ...agentTerminal(1),
        state: "exited",
        exitCode: 0,
        signal: null,
      }
      expect(inboxRows(inputs(workspaceOf(exited), { entries: [report()] }))).toMatchObject([
        { id: "entry:done-1", update: { type: "done" } },
      ])
      expect(inboxRows(inputs(workspaceOf(), { entries: [report()] }))).toEqual([])
    })

    it("is the person's for a worker too, while its lead runs or not", () => {
      const entries = [report({ terminalId: "02", handle: "fox" })]
      expect(inboxRows(inputs(workspaceOf(agentTerminal(1), worker()), { entries }))).toMatchObject(
        [{ id: "entry:done-1", update: { type: "done" } }],
      )
      const shell = { ...agentTerminal(1), process: "bash" }
      expect(inboxRows(inputs(workspaceOf(shell, worker()), { entries }))).toMatchObject([
        { id: "entry:done-1" },
      ])
      expect(inboxRows(inputs(workspaceOf(worker()), { entries }))).toMatchObject([
        { id: "entry:done-1" },
      ])
    })

    it("is the person's for a worker that told, like its done", () => {
      const told = report({
        terminalId: "02",
        handle: "fox",
        content: { kind: "tell", subject: "Heads-up", body: "b" },
      })
      expect(
        inboxRows(inputs(workspaceOf(agentTerminal(1), worker()), { entries: [told] })),
      ).toMatchObject([{ update: { type: "told" } }])
    })
  })

  describe("whether a lead hears of a terminal", () => {
    const worker: TerminalMetadata = { ...agentTerminal(2), ledBy: "moth" }

    it("is so while the lead's agent runs, and not once it stopped, closed, or for a terminal it doesn't lead", () => {
      expect(leadHearsOf(workspaceOf(agentTerminal(1), worker), "p/s", "02")).toBe(true)
      expect(leadHearsOf(workspaceOf(agentTerminal(1), worker), "p/s", "01")).toBe(false)
      expect(leadHearsOf(workspaceOf(agentTerminal(1), worker), "q/s", "02")).toBe(false)
      const shell = { ...agentTerminal(1), process: "bash" }
      expect(leadHearsOf(workspaceOf(shell, worker), "p/s", "02")).toBe(false)
      expect(leadHearsOf(workspaceOf(worker), "p/s", "02")).toBe(false)
    })
  })

  describe("a failed turn", () => {
    const ended = (end: Partial<AgentTurnEnd>) =>
      workspaceOf(
        agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed", ...end }) }),
      )

    it("is trouble with its error while its mark is unread", () => {
      const [row] = inboxRows(inputs(ended({ error: "API Error: 529" }), { unread: failed }))

      expect(row).toMatchObject({
        id: "trouble:01:100",
        at: 100,
        stopped: true,
        kind: "trouble",
        trouble: { type: "failed", error: "API Error: 529" },
      })
    })

    it("has no error to show where its harness gave none", () => {
      const [row] = inboxRows(inputs(ended({}), { unread: failed }))

      expect(row).toMatchObject({ trouble: { type: "failed", error: null } })
    })

    it("goes once the person has viewed the terminal", () => {
      expect(inboxRows(inputs(ended({ error: "x" })))).toEqual([])
    })

    it("informs, and doesn't stop the agent, once it is no longer the current end", () => {
      const row = rowsOf(ended({ error: "x" }), failed)[0]!
      const rows = inboxRows({
        ...inputs(ended({ error: "x" })),
        turns: [row, { ...row, id: "older", at: 50 }],
      })

      expect(rows.map(({ id, stopped }) => [id, stopped]).toSorted()).toEqual([
        ["older", false],
        ["trouble:01:100", true],
      ])
    })

    it("informs while the agent works on", () => {
      const row = rowsOf(ended({}), failed)[0]!
      const working = workspaceOf(
        agentTerminal(1, { working: true, lastTurn: turn({ outcome: "failed" }) }),
      )

      expect(inboxRows({ ...inputs(working), turns: [row] })).toMatchObject([{ stopped: false }])
    })
  })

  describe("a usage limit", () => {
    const limited = (end: Partial<AgentTurnEnd>) =>
      workspaceOf(
        agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed", ...end }) }),
      )

    it("is trouble Novadeck can't resume, shown without an unread mark", () => {
      const [row] = inboxRows(
        inputs(limited({ error: "5-hour limit reached", limit: { minutes: 300, resetsAt: 9e12 } })),
      )

      expect(row).toMatchObject({
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
      const [row] = inboxRows(inputs(limited({ limit: { minutes: null, resetsAt: 9e12 } })))

      expect(row).toMatchObject({
        trouble: { minutes: 0, evidence: [{ text: "Usage limit reached" }] },
      })
    })

    it("is derived from the current end, with no row stored for it", () => {
      const rows = inboxRows(
        inputs(limited({ error: "x", limit: { minutes: 60, resetsAt: 9e12 } })),
      )

      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ trouble: { type: "limit" } })
    })

    it("is failed trouble where it was limited with no window found", () => {
      const [row] = inboxRows(inputs(limited({ error: "x", limited: true })))

      expect(row).toMatchObject({
        id: "limit:01:100",
        stopped: true,
        trouble: { type: "failed", error: "x" },
      })
    })

    it("goes with the agent's next turn", () => {
      const next = workspaceOf(agentTerminal(1, { working: true }))

      expect(inboxRows(inputs(next))).toEqual([])
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
      const [row] = inboxRows(inputs(pair, { messages: messagesOf(held) }))

      expect(row).toMatchObject({
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
          heldFor: "loop",
        },
      })
    })

    it("carries why the thread is held, or none", () => {
      const reason = (heldFor: "loop" | null) =>
        inboxRows(inputs(pair, { messages: messagesOf(thread({ heldFor })) }))[0]
      expect(reason("loop")).toMatchObject({ held: { heldFor: "loop" } })
      expect(reason(null)).toMatchObject({ held: { heldFor: null } })
    })

    it("is one row for a thread both its terminals list", () => {
      const messages: MessagesState = {
        ...noMessages,
        terminals: {
          "p/s/01": { handle: "moth", agent: true, threads: [thread()] },
          "p/s/02": { handle: "fox", agent: true, threads: [thread({ peer: agentParty("moth") })] },
        },
      }

      expect(inboxRows(inputs(pair, { messages }))).toHaveLength(1)
    })

    it("is not stopped while the sender's agent works", () => {
      const busy = workspaceOf(
        agentTerminal(1, { working: true }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const [row] = inboxRows(inputs(busy, { messages: messagesOf(thread()) }))

      expect(row).toMatchObject({ stopped: false })
    })

    it("comes from the recipient's terminal where the sender is gone", () => {
      const alone = workspaceOf(agentTerminal(2, { working: false }, "codex"))
      const [row] = inboxRows(inputs(alone, { messages: messagesOf(thread()) }))

      expect(row).toMatchObject({
        stopped: true,
        source: { terminalId: "02", agent: "codex" },
        held: { from: { handle: "moth", title: "moth" }, to: { title: "Terminal 2" } },
      })
    })

    it("is none while messaging is paused, and none once released", () => {
      const paused = thread({ messages: [message({ held: "paused" })] })

      expect(inboxRows(inputs(pair, { messages: messagesOf(paused) }))).toEqual([])
      expect(inboxRows(inputs(pair, { messages: messagesOf(thread({ held: false })) }))).toEqual([])
    })
  })

  describe("messages held long behind what keeps the doorbell from an idle agent", () => {
    // Codex in fox is idle with moth's messages for it, its box holding text since 1 000.
    const pair = workspaceOf(
      agentTerminal(1, { working: false }),
      agentTerminal(2, { working: false }, "codex"),
    )
    const waiting = (change: Partial<AgentMessage> = {}) =>
      message({ state: "queued", held: null, ...change })
    const heldFor = (
      messages: readonly AgentMessage[],
      waits: TerminalThreads["waits"] = "draft",
    ): MessagesState => ({
      ...noMessages,
      terminals: {
        "p/s/02": {
          handle: "fox",
          agent: true,
          waits,
          waitsSince: 1_000,
          threads: [thread({ peer: agentParty("moth"), held: false, messages })],
        },
      },
    })
    const at = 1_000 + longHoldMs

    it("is a trouble row of the recipient's terminal, from when the hold began", () => {
      const messages = heldFor([waiting({ id: "m1" }), waiting({ id: "m2", state: "leased" })])
      expect(inboxRows(inputs(pair, { messages, now: at }))).toEqual([
        expect.objectContaining({
          id: "waits:02:1000",
          at: 1_000,
          stopped: true,
          source: expect.objectContaining({
            terminalId: "02",
            handle: "fox",
            agent: "codex",
          }),
          kind: "trouble",
          // The leased one is on its way: only the queued one is held.
          trouble: { type: "waits", waits: "draft", count: 1 },
        }),
      ])
    })

    it("is none while the agent works, as its status says, whatever the listing last said", () => {
      const busy = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, { working: true }, "codex"),
      )
      expect(inboxRows(inputs(busy, { messages: heldFor([waiting()]), now: at }))).toEqual([])
    })

    it("says why it holds as the hold says, whatever that is", () => {
      const [row] = inboxRows(inputs(pair, { messages: heldFor([waiting()], "dialog"), now: at }))
      expect(row).toMatchObject({
        trouble: { type: "waits", waits: "dialog", count: 1 },
      })
    })

    it("is raised where the doorbell gave no reason, as when the screen never calms", () => {
      const [row] = inboxRows(inputs(pair, { messages: heldFor([waiting()], null), now: at }))
      expect(row).toMatchObject({ trouble: { type: "waits", waits: null, count: 1 } })
    })

    it("is none until the hold has lasted, nor once no message waits or the hold ends", () => {
      expect(inboxRows(inputs(pair, { messages: heldFor([waiting()]), now: at - 1 }))).toEqual([])
      const delivered = waiting({ state: "delivered", deliveredAt: 2_000 })
      expect(inboxRows(inputs(pair, { messages: heldFor([delivered]), now: at }))).toEqual([])
      const ended: MessagesState = {
        ...heldFor([waiting()]),
        terminals: {
          "p/s/02": { ...heldFor([waiting()]).terminals["p/s/02"]!, waitsSince: null },
        },
      }
      expect(inboxRows(inputs(pair, { messages: ended, now: at }))).toEqual([])
      // Moth's own messages to fox wait in its listing, not for it.
      const sent = heldFor([waiting({ from: agentParty("fox"), to: agentParty("moth") })])
      expect(inboxRows(inputs(pair, { messages: sent, now: at }))).toEqual([])
    })

    it("counts no message held for the person's release, or a pause, which have their own", () => {
      const messages = heldFor([
        waiting(),
        message({ id: "m2" }),
        waiting({ id: "m3", state: "held", held: "paused" }),
      ])
      const rows = inboxRows(inputs(pair, { messages, now: at }))
      expect(rows.find((row) => row.kind === "trouble")).toMatchObject({
        trouble: { count: 1 },
      })
    })

    it("gives way to the agent's own ask, and comes whatever turn it last ended", () => {
      const ask = entry({ terminalId: "02", agent: "codex", handle: "fox" })
      const [shown] = inboxRows(
        inputs(pair, { messages: heldFor([waiting()]), entries: [ask], now: at }),
      )
      expect(shown).toMatchObject({ id: "entry-1", kind: "ask" })
      const finished = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, { working: false, lastTurn: turn() }, "codex"),
      )
      const [first] = inboxRows(
        inputs(finished, {
          messages: heldFor([waiting()]),
          unread: { "p/s": { "02": "done" } },
          now: at,
        }),
      )
      expect(first).toMatchObject({ kind: "trouble", trouble: { type: "waits" } })
    })

    it("gives way to a request waiting on the person in that terminal", () => {
      const asking = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, { working: false, attention: { kind: "permission", count: 1 } }, "codex"),
      )
      const [row] = inboxRows(
        inputs(asking, {
          messages: heldFor([waiting()], "asking"),
          requests: { "02": [asked("r1", 0)] },
          now: at,
        }),
      )
      expect(row).toMatchObject({ kind: "request" })
    })
  })

  describe("a terminal with several", () => {
    it("shows the request of a running turn, not the completed turn from before", () => {
      const both = workspaceOf(
        agentTerminal(1, {
          working: true,
          attention: { kind: "permission", count: 1 },
          lastTurn: turn({ reply: "old" }),
        }),
      )
      const rows = inboxRows(inputs(both, { unread: done, requests: { "01": [asked("r1", 5)] } }))

      expect(rows.map((row) => row.id)).toEqual(["request:r1"])
    })

    it("keeps a held thread beside the terminal's other row", () => {
      const pair = workspaceOf(
        agentTerminal(1, {
          working: false,
          lastTurn: turn({ outcome: "failed", error: "x" }),
        }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const rows = inboxRows(inputs(pair, { unread: failed, messages: messagesOf(thread()) }))

      expect(rows.map((row) => row.id)).toEqual(["trouble:01:100", "held:th1"])
    })

    it("shows every held thread, the longest waiting first", () => {
      const both = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const messages: MessagesState = {
        ...noMessages,
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

      expect(inboxRows(inputs(both, { messages })).map((row) => row.id)).toEqual([
        "held:older",
        "held:newer",
      ])
    })
  })

  describe("the whole list", () => {
    it("orders by urgency, then by how long each waited", () => {
      const workspace = workspaceOf(
        agentTerminal(1, { working: false, lastTurn: turn({ at: 10, reply: "a" }) }),
        agentTerminal(2, { working: true, attention: { kind: "permission", count: 1 } }),
        agentTerminal(3, { working: false, lastTurn: turn({ at: 5, outcome: "failed" }) }),
        agentTerminal(4, { working: false }, "zsh"),
      )
      const rows = inboxRows(
        inputs(workspace, {
          unread: { "p/s": { "01": "done", "03": "failed" } },
          requests: { "02": [asked("r1", 20)] },
        }),
      )

      expect(rows.map((row) => row.id)).toEqual(["trouble:03:5", "request:r1"])
    })

    it("holds nothing for a terminal that runs no agent, and nothing for completed turns", () => {
      const shell: TerminalMetadata = {
        id: "01",
        name: "Shell",
        directory: "/work/app",
        command: "zsh",
        process: "zsh",
        state: "idle",
      }
      const rows = inboxRows(
        inputs(workspaceOf(shell, agentTerminal(2, { working: false, lastTurn: turn() })), {
          unread: { "p/s": { "01": "done", "02": "done" } },
        }),
      )

      expect(rows).toEqual([])
    })
  })

  describe("an entry", () => {
    const attention: AgentStatus = { working: true, attention: { kind: "permission", count: 1 } }
    const told = (id = "told-1"): WrittenEntry =>
      entry({ id, content: { kind: "tell", subject: "Preview ready", body: "Open the preview." } })

    it("derives whether an ask waits from the agent's current working state", () => {
      for (const agent of ["claude", "codex", "agy"] as const) {
        for (const working of [true, false]) {
          const rows = inboxRows(
            inputs(workspaceOf(agentTerminal(1, { working }, agent)), {
              entries: [entry({ agent })],
            }),
          )
          expect(rows[0]).toMatchObject({ kind: "ask", stopped: !working, source: { agent } })
        }
      }
    })

    it("lists a settled ask as a settled row, stopped false, whatever its terminal's agent does now", () => {
      const settled = entry({ settled: { how: "dismissed", at: 5000 } })
      // Working, resting, another agent's session in the terminal, and an ended one.
      const exited: TerminalMetadata = {
        ...agentTerminal(1),
        state: "exited",
        exitCode: 0,
        signal: null,
      }
      for (const terminal of [
        agentTerminal(1, { working: true }),
        agentTerminal(1, { working: false }),
        agentTerminal(1, { working: false }, "codex"),
        exited,
      ]) {
        expect(inboxRows(inputs(workspaceOf(terminal), { entries: [settled] }))).toMatchObject([
          { id: "entry-1", kind: "ask", stopped: false, settled: { how: "dismissed", at: 5000 } },
        ])
      }
      // An open ask of an agent that is no longer there is dropped, a settled one is not; neither
      // outlives its terminal.
      const other = workspaceOf(agentTerminal(1, { working: false }, "codex"))
      expect(inboxRows(inputs(other, { entries: [entry()] }))).toEqual([])
      expect(inboxRows(inputs(workspaceOf(), { entries: [settled] }))).toEqual([])
    })

    it("lists settled asks after everything else, the latest settled first", () => {
      const entries = [
        entry({ id: "old", settled: { how: "withdrawn", at: 6000 } }),
        entry({ id: "new", settled: { how: "replied", at: 9000 } }),
        told("told"),
        entry({ id: "open" }),
      ]
      const rows = inboxRows(inputs(workspaceOf(agentTerminal(1, { working: false })), { entries }))
      expect(rows.map(({ id }) => id)).toEqual(["open", "told", "new", "old"])
    })

    it("keeps an unread tell after its agent exits, with its original attribution", () => {
      const exited: TerminalMetadata = {
        ...agentTerminal(1),
        state: "exited",
        exitCode: 0,
        signal: null,
      }
      const rows = inboxRows(inputs(workspaceOf(exited), { entries: [entry(), told()] }))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        id: "told-1",
        kind: "update",
        stopped: false,
        source: { agent: "claude", handle: "moth" },
        update: { type: "told" },
      })
      expect(inboxRows(inputs(workspaceOf(), { entries: [told()] }))).toEqual([])
    })

    it("lists a current permission or plan and an older stopped MCP ask, each its own row", () => {
      for (const kind of ["permission", "plan"] as const) {
        const request = asked("gate", 8000)
        const waiting = workspaceOf(
          agentTerminal(1, { working: false, attention: { kind, count: 1 } }),
        )
        const rows = inboxRows(
          inputs(waiting, {
            entries: [entry()],
            requests: { "01": [{ ...request, request: { ...request.request, kind } }] },
          }),
        )
        expect(rows.map(({ id }) => id).toSorted()).toEqual(["entry-1", "request:gate"])
      }
    })

    it("keeps a gate's unread dialog grace for the request's row, not for the ask beside it", () => {
      const waiting = workspaceOf(agentTerminal(1, attention))
      for (const requests of [{}, { "01": [asked("gate", 9500, null)] }]) {
        const rows = inboxRows(inputs(waiting, { entries: [entry()], requests }))
        expect(rows.map(({ id }) => id)).toEqual(["entry-1"])
      }
    })

    it("lists a stopped question and an MCP ask beside it", () => {
      const question = asked("question", 8000)
      const waiting = workspaceOf(
        agentTerminal(1, { working: false, attention: { kind: "question", count: 1 } }),
      )
      const rows = inboxRows(
        inputs(waiting, {
          entries: [entry()],
          requests: { "01": [{ ...question, request: { ...question.request, kind: "question" } }] },
        }),
      )
      expect(rows.map(({ id }) => id).toSorted()).toEqual(["entry-1", "request:question"])
    })

    it("lists two tells from one terminal, the newer beside the older", () => {
      const rows = inboxRows(
        inputs(workspaceOf(agentTerminal(1, { working: false })), {
          entries: [
            { ...told("merged"), at: 20 },
            { ...told("opened"), at: 10 },
          ],
        }),
      )
      expect(rows.map(({ id }) => id)).toEqual(["opened", "merged"])
    })

    it("lists an ask beside the tells of the same terminal, and not its completed turn", () => {
      const rows = inboxRows(
        inputs(workspaceOf(agentTerminal(1, { working: false, lastTurn: turn() })), {
          unread: done,
          entries: [entry({ id: "ask" }), told("t1"), told("t2")],
        }),
      )
      expect(rows.map(({ id }) => id).toSorted()).toEqual(["ask", "t1", "t2"])
    })

    it("ignores entries for terminals outside their recorded ownership context", () => {
      for (const change of [
        { terminalId: "closed" },
        { projectId: "elsewhere" },
        { workspaceSessionId: "other" },
        { handle: "old-handle" },
        { agent: "codex" as const },
      ]) {
        expect(
          inboxRows(inputs(workspaceOf(agentTerminal(1)), { entries: [entry(change)] })),
        ).toEqual([])
      }
    })
  })
})
