import { longHoldMs } from "@novadeck/protocol"

import type { ChatDialog, ChatPermit } from "../conversation"
import { inboxType, type InboxTurn } from "../inbox"
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
  inboxEntries,
  leadHearsOf,
  type Asked,
  type InboxInputs,
  type WrittenEntry,
} from "./entries"

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

// The marks these tests state, by session context then terminal, stand for the stored entry of
// that terminal's current end: the entry the runner keeps for it.
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
  permits: {},
  entries: [],
  now: 10_000,
  longHoldMs,
  ...more,
})

const written = (change: Partial<WrittenEntry> = {}): WrittenEntry => ({
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

describe("The Inbox's entries", () => {
  it("makes no entry of an agent held at its startup screen: its tab says so", () => {
    const held = workspaceOf(agentTerminal(1, { working: false, startup: "startup" }))
    expect(inboxEntries(inputs(held, { now: 60 * 60_000 }))).toEqual([])
  })

  describe("a standing permit of the shipping gate", () => {
    const permit = (change: Partial<ChatPermit> = {}): ChatPermit => ({
      id: "p1",
      title: "Merge PR #1190 into main",
      quote: "go ahead and merge it",
      givenAt: 3000,
      until: 9_000_000,
      usedAt: null,
      ...change,
    })
    const idle = workspaceOf(agentTerminal(1))

    it("makes one entry per permit, given when it was, that asks nothing of the person", () => {
      const entries = inboxEntries(
        inputs(idle, { permits: { "01": [permit(), permit({ id: "p2", givenAt: 4000 })] } }),
      )

      expect(entries.map((entry) => entry.id).toSorted()).toEqual(["permit:01:p1", "permit:01:p2"])
      expect(entries[1]).toMatchObject({
        id: "permit:01:p1",
        at: 3000,
        stopped: false,
        kind: "permit",
        permit: { title: "Merge PR #1190 into main" },
        source: { terminalId: "01", handle: "moth", title: "Terminal 1" },
      })
      expect(entries.map(inboxType)).toEqual(["update", "update"])
    })

    it("makes none where the detail says none, or the terminal has no running agent", () => {
      expect(inboxEntries(inputs(idle))).toEqual([])
      expect(inboxEntries(inputs(idle, { permits: { "01": [] } }))).toEqual([])
      const asleep = workspaceOf({
        id: "01",
        name: "Terminal 1",
        directory: "/work/app",
        command: "claude",
        handle: "moth",
        state: "sleeping",
        agent: "claude",
      } as TerminalMetadata)
      expect(inboxEntries(inputs(asleep, { permits: { "01": [permit()] } }))).toEqual([])
    })

    it("is gone from the entries once the permit no longer stands", () => {
      const before = inboxEntries(inputs(idle, { permits: { "01": [permit()] } }))
      const after = inboxEntries(inputs(idle, { permits: { "01": [] } }))

      expect(before).toHaveLength(1)
      expect(after).toEqual([])
    })
  })

  describe("a request", () => {
    const waiting = workspaceOf(
      agentTerminal(1, { working: true, attention: { kind: "permission", count: 1 } }),
    )

    it("comes from the oldest request, waiting since it was asked", () => {
      const entries = inboxEntries(
        inputs(waiting, {
          requests: { "01": [asked("r1", 4000), asked("r2", 5000), asked("r3", 6000)] },
          now: 5500,
        }),
      )

      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
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

      expect(inboxEntries(inputs(waiting, { requests, now: 5000 }))).toEqual([])
      expect(inboxEntries(inputs(waiting, { requests, now: 4000 + dialogMs }))[0]).toMatchObject({
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
      const entries = inboxEntries(
        inputs(both, { unread: failed, requests: { "01": [asked("r1", 9000)] } }),
      )
      const pending = inboxEntries(inputs(both, { unread: failed, requests: {} }))

      // A subagent's or the screen's request can stand after the root's Stop.
      expect(entries.map((entry) => entry.id).toSorted()).toEqual(["request:r1", "trouble:01:100"])
      expect(pending.map((entry) => entry.id)).toEqual(["trouble:01:100"])
    })

    it("waits for a dialog a moment, then shows without one to be answered in the terminal", () => {
      const requests = { "01": [asked("r1", 4000, null)] }

      expect(inboxEntries(inputs(waiting, { requests, now: 4000 + dialogMs - 1 }))).toEqual([])
      const [entry] = inboxEntries(inputs(waiting, { requests, now: 4000 + dialogMs }))
      expect(entry).toMatchObject({ id: "request:r1", kind: "request", request: { dialog: null } })
    })

    // `request_permit` answers at once, so the agent ends its turn while the gate's card waits:
    // the runner counts each card as a request asked without waiting.
    describe("the shipping gate's card", () => {
      const card = (id: string, askedAt: number, title: string): Asked => ({
        request: {
          ...asked(id, askedAt).request,
          tool: "request_permit",
          subject: title,
          choices: ["Allow", "Deny"],
          dialog: { ...choices, id: `permit-${id}`, title },
          detached: true,
        },
        askedAt,
      })
      const ended = (count: number) =>
        workspaceOf(
          agentTerminal(1, {
            working: false,
            attention: { kind: "permission", count, detached: true },
            lastTurn: turn(),
          }),
        )

      it("waits on the person after the agent's turn ended, each card its own", () => {
        const requests = {
          "01": [card("c1", 4000, "Merge PR #1189?"), card("c2", 4100, "Merge PR #1191?")],
        }
        const entries = inboxEntries(inputs(ended(2), { requests, now: 9000 }))

        // Newest first, as the Inbox lists.
        expect(entries.filter((entry) => entry.kind === "request")).toMatchObject([
          { id: "request:c2", at: 4100, stopped: true, request: { subject: "Merge PR #1191?" } },
          { id: "request:c1", at: 4000, stopped: true, request: { subject: "Merge PR #1189?" } },
        ])
      })

      it("stands beside the harness's own request, which still shows only its oldest", () => {
        const requests = {
          "01": [asked("r1", 4000), asked("r2", 4200), card("c1", 4100, "Merge PR #5?")],
        }
        const entries = inboxEntries(inputs(waiting, { requests, now: 9000 }))

        expect(entries.map((entry) => entry.id).toSorted()).toEqual(["request:c1", "request:r1"])
      })

      it("is gone once nothing waits: answered, given by the person's words, or closed", () => {
        const requests = { "01": [card("c1", 4000, "Merge PR #5?")] }
        const rested = workspaceOf(agentTerminal(1, { working: false, lastTurn: turn() }))

        expect(inboxEntries(inputs(rested, { requests, now: 9000 }))).toEqual([])
      })
    })

    it("is none once the agent no longer waits, whatever was last read", () => {
      const rested = workspaceOf(agentTerminal(1))

      expect(inboxEntries(inputs(rested, { requests: { "01": [asked("r1", 1)] } }))).toEqual([])
    })

    it("keeps its identity and time across changes elsewhere", () => {
      const first = inboxEntries(inputs(waiting, { requests: { "01": [asked("r1", 4000)] } }))
      const later = inboxEntries(
        inputs(waiting, { requests: { "01": [asked("r1", 4000)] }, now: 99_000 }),
      )

      expect(later[0]!.id).toBe(first[0]!.id)
      expect(later[0]!.at).toBe(first[0]!.at)
    })
  })

  describe("a completed turn", () => {
    const rested = (end: Partial<AgentTurnEnd>) =>
      workspaceOf(agentTerminal(1, { working: false, lastTurn: turn(end) }))

    it("makes no entry, stored or not: it only marks its tab", () => {
      expect(
        inboxEntries(inputs(rested({ reply: "Done. Tests pass." }), { unread: done })),
      ).toEqual([])
      expect(inboxEntries(inputs(rested({})))).toEqual([])
    })

    it("leaves a failed entry of the same terminal as it was", () => {
      const ws = rested({ outcome: "failed", error: "x" })
      expect(inboxEntries(inputs(ws, { unread: failed }))).toMatchObject([
        { id: "trouble:01:100", kind: "trouble" },
      ])
    })
  })

  describe("a done report", () => {
    const report = (change: Partial<WrittenEntry> = {}): WrittenEntry =>
      written({
        id: "entry:done-1",
        content: { kind: "done", subject: "Search rebuilt", body: "All 412 pages." },
        ...change,
      })
    const worker = (): TerminalMetadata => ({ ...agentTerminal(2), ledBy: "01" })

    it("is an update of its terminal that the person reads, not stopping the agent", () => {
      const entries = inboxEntries(inputs(workspaceOf(agentTerminal(1)), { entries: [report()] }))
      expect(entries).toMatchObject([
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
      const entries = inboxEntries(inputs(workspaceOf(bare), { entries: [report({ handle: "" })] }))
      expect(entries).toMatchObject([{ id: "entry:done-1", update: { type: "done" } }])
    })

    it("stays after its agent exits, like a tell", () => {
      const exited: TerminalMetadata = {
        ...agentTerminal(1),
        state: "exited",
        exitCode: 0,
        signal: null,
      }
      expect(inboxEntries(inputs(workspaceOf(exited), { entries: [report()] }))).toMatchObject([
        { id: "entry:done-1", update: { type: "done" } },
      ])
      expect(inboxEntries(inputs(workspaceOf(), { entries: [report()] }))).toEqual([])
    })

    it("is the person's for a worker too, while its lead runs or not", () => {
      const given = [report({ terminalId: "02", handle: "fox" })]
      expect(
        inboxEntries(inputs(workspaceOf(agentTerminal(1), worker()), { entries: given })),
      ).toMatchObject([{ id: "entry:done-1", update: { type: "done" } }])
      const shell = { ...agentTerminal(1), process: "bash" }
      expect(inboxEntries(inputs(workspaceOf(shell, worker()), { entries: given }))).toMatchObject([
        { id: "entry:done-1" },
      ])
      expect(inboxEntries(inputs(workspaceOf(worker()), { entries: given }))).toMatchObject([
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
        inboxEntries(inputs(workspaceOf(agentTerminal(1), worker()), { entries: [told] })),
      ).toMatchObject([{ update: { type: "told" } }])
    })
  })

  describe("whether a lead hears of a terminal", () => {
    const worker: TerminalMetadata = { ...agentTerminal(2), ledBy: "01" }

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
      const [entry] = inboxEntries(inputs(ended({ error: "API Error: 529" }), { unread: failed }))

      expect(entry).toMatchObject({
        id: "trouble:01:100",
        at: 100,
        stopped: true,
        kind: "trouble",
        trouble: { type: "failed", error: "API Error: 529" },
      })
    })

    it("has no error to show where its harness gave none", () => {
      const [entry] = inboxEntries(inputs(ended({}), { unread: failed }))

      expect(entry).toMatchObject({ trouble: { type: "failed", error: null } })
    })

    it("goes once the person has viewed the terminal", () => {
      expect(inboxEntries(inputs(ended({ error: "x" })))).toEqual([])
    })

    it("informs, and doesn't stop the agent, once it is no longer the current end", () => {
      const entry = rowsOf(ended({ error: "x" }), failed)[0]!
      const entries = inboxEntries({
        ...inputs(ended({ error: "x" })),
        turns: [entry, { ...entry, id: "older", at: 50 }],
      })

      expect(entries.map(({ id, stopped }) => [id, stopped]).toSorted()).toEqual([
        ["older", false],
        ["trouble:01:100", true],
      ])
    })

    it("informs while the agent works on", () => {
      const entry = rowsOf(ended({}), failed)[0]!
      const working = workspaceOf(
        agentTerminal(1, { working: true, lastTurn: turn({ outcome: "failed" }) }),
      )

      expect(inboxEntries({ ...inputs(working), turns: [entry] })).toMatchObject([
        { stopped: false },
      ])
    })
  })

  describe("a usage limit", () => {
    const limited = (end: Partial<AgentTurnEnd>) =>
      workspaceOf(
        agentTerminal(1, { working: false, lastTurn: turn({ outcome: "failed", ...end }) }),
      )

    it("is trouble Novadeck can't resume, shown without an unread mark", () => {
      const [entry] = inboxEntries(
        inputs(limited({ error: "5-hour limit reached", limit: { minutes: 300, resetsAt: 9e12 } })),
      )

      expect(entry).toMatchObject({
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
      const [entry] = inboxEntries(inputs(limited({ limit: { minutes: null, resetsAt: 9e12 } })))

      expect(entry).toMatchObject({
        trouble: { minutes: 0, evidence: [{ text: "Usage limit reached" }] },
      })
    })

    it("is derived from the current end, with no entry stored for it", () => {
      const entries = inboxEntries(
        inputs(limited({ error: "x", limit: { minutes: 60, resetsAt: 9e12 } })),
      )

      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ trouble: { type: "limit" } })
    })

    it("is failed trouble where it was limited with no window found", () => {
      const [entry] = inboxEntries(inputs(limited({ error: "x", limited: true })))

      expect(entry).toMatchObject({
        id: "limit:01:100",
        stopped: true,
        trouble: { type: "failed", error: "x" },
      })
    })

    it("goes with the agent's next turn", () => {
      const next = workspaceOf(agentTerminal(1, { working: true }))

      expect(inboxEntries(inputs(next))).toEqual([])
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
      const [entry] = inboxEntries(inputs(pair, { messages: messagesOf(held) }))

      expect(entry).toMatchObject({
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
        inboxEntries(inputs(pair, { messages: messagesOf(thread({ heldFor })) }))[0]
      expect(reason("loop")).toMatchObject({ held: { heldFor: "loop" } })
      expect(reason(null)).toMatchObject({ held: { heldFor: null } })
    })

    it("is one entry for a thread both its terminals list", () => {
      const messages: MessagesState = {
        ...noMessages,
        terminals: {
          "p/s/01": { terminalId: "01", handle: "moth", agent: true, threads: [thread()] },
          "p/s/02": {
            terminalId: "02",
            handle: "fox",
            agent: true,
            threads: [thread({ peer: agentParty("moth") })],
          },
        },
      }

      expect(inboxEntries(inputs(pair, { messages }))).toHaveLength(1)
    })

    it("is not stopped while the sender's agent works", () => {
      const busy = workspaceOf(
        agentTerminal(1, { working: true }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const [entry] = inboxEntries(inputs(busy, { messages: messagesOf(thread()) }))

      expect(entry).toMatchObject({ stopped: false })
    })

    it("comes from the recipient's terminal where the sender is gone", () => {
      const alone = workspaceOf(agentTerminal(2, { working: false }, "codex"))
      const [entry] = inboxEntries(inputs(alone, { messages: messagesOf(thread()) }))

      expect(entry).toMatchObject({
        stopped: true,
        source: { terminalId: "02", agent: "codex" },
        held: { from: { handle: "moth", title: "moth" }, to: { title: "Terminal 2" } },
      })
    })

    it("names its parties by terminal, not by handle: another terminal with a sender's handle isn't it", () => {
      // moth (01) closed, and 03 has its handle now; the held message is moth's, to fox (02).
      const stranger: TerminalMetadata = { ...agentTerminal(3), handle: "moth" }
      const workspace = workspaceOf(agentTerminal(2, { working: false }, "codex"), stranger)
      const [entry] = inboxEntries(inputs(workspace, { messages: messagesOf(thread()) }))

      expect(entry).toMatchObject({
        stopped: true,
        source: { terminalId: "02", agent: "codex" },
        held: { from: { handle: "moth", title: "moth" }, to: { title: "Terminal 2" } },
      })
    })

    it("finds its agents in the session that lists it, where another session reuses their handles", () => {
      const shell = (number: number): TerminalMetadata => ({
        ...agentTerminal(number),
        command: "bash",
        process: "bash",
      })
      const project = (id: string, terminals: TerminalMetadata[]) => ({
        ...workspaceOf(...terminals).projects[0]!,
        id,
        name: `Project ${id}`,
        activeSessionId: `${id}-s`,
        history: [
          {
            ...workspaceOf(...terminals).projects[0]!.history[0]!,
            id: `${id}-s`,
          },
        ],
      })
      // Project one's moth and fox run shells; project two's run agents, their thread held.
      const one = project("one", [shell(1), shell(2)])
      const two = project("two", [agentTerminal(1), agentTerminal(2, { working: false }, "codex")])
      const messages: MessagesState = {
        ...noMessages,
        terminals: {
          "two/two-s/01": { terminalId: "01", handle: "moth", agent: true, threads: [thread()] },
        },
      }

      for (const projects of [
        [one, two],
        [two, one],
      ]) {
        const entries = inboxEntries(inputs({ activeProjectId: "one", projects }, { messages }))
        expect(entries).toMatchObject([
          {
            id: "held:th1",
            source: { projectId: "two", workspaceSessionId: "two-s", terminalId: "01" },
          },
        ])
      }
    })

    it("is none while messaging is paused, and none once released", () => {
      const paused = thread({ messages: [message({ held: "paused" })] })

      expect(inboxEntries(inputs(pair, { messages: messagesOf(paused) }))).toEqual([])
      expect(inboxEntries(inputs(pair, { messages: messagesOf(thread({ held: false })) }))).toEqual(
        [],
      )
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
          terminalId: "02",
          handle: "fox",
          agent: true,
          waits,
          waitsSince: 1_000,
          threads: [thread({ peer: agentParty("moth"), held: false, messages })],
        },
      },
    })
    const at = 1_000 + longHoldMs

    it("is a trouble entry of the recipient's terminal, from when the hold began", () => {
      const messages = heldFor([waiting({ id: "m1" }), waiting({ id: "m2", state: "leased" })])
      expect(inboxEntries(inputs(pair, { messages, now: at }))).toEqual([
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
      expect(inboxEntries(inputs(busy, { messages: heldFor([waiting()]), now: at }))).toEqual([])
    })

    it("says why it holds as the hold says, whatever that is", () => {
      const [entry] = inboxEntries(
        inputs(pair, { messages: heldFor([waiting()], "dialog"), now: at }),
      )
      expect(entry).toMatchObject({
        trouble: { type: "waits", waits: "dialog", count: 1 },
      })
    })

    it("is raised where the doorbell gave no reason, as when the screen never calms", () => {
      const [entry] = inboxEntries(inputs(pair, { messages: heldFor([waiting()], null), now: at }))
      expect(entry).toMatchObject({ trouble: { type: "waits", waits: null, count: 1 } })
    })

    it("is none until the hold has lasted, nor once no message waits or the hold ends", () => {
      expect(inboxEntries(inputs(pair, { messages: heldFor([waiting()]), now: at - 1 }))).toEqual(
        [],
      )
      const delivered = waiting({ state: "delivered", deliveredAt: 2_000 })
      expect(inboxEntries(inputs(pair, { messages: heldFor([delivered]), now: at }))).toEqual([])
      const ended: MessagesState = {
        ...heldFor([waiting()]),
        terminals: {
          "p/s/02": { ...heldFor([waiting()]).terminals["p/s/02"]!, waitsSince: null },
        },
      }
      expect(inboxEntries(inputs(pair, { messages: ended, now: at }))).toEqual([])
      // Moth's own messages to fox wait in its listing, not for it.
      const sent = heldFor([waiting({ from: agentParty("fox"), to: agentParty("moth") })])
      expect(inboxEntries(inputs(pair, { messages: sent, now: at }))).toEqual([])
    })

    it("counts no message held for the person's release, or a pause, which have their own", () => {
      const messages = heldFor([
        waiting(),
        message({ id: "m2" }),
        waiting({ id: "m3", state: "held", held: "paused" }),
      ])
      const entries = inboxEntries(inputs(pair, { messages, now: at }))
      expect(entries.find((entry) => entry.kind === "trouble")).toMatchObject({
        trouble: { count: 1 },
      })
    })

    it("gives way to the agent's own ask, and comes whatever turn it last ended", () => {
      const ask = written({ terminalId: "02", agent: "codex", handle: "fox" })
      const [shown] = inboxEntries(
        inputs(pair, { messages: heldFor([waiting()]), entries: [ask], now: at }),
      )
      expect(shown).toMatchObject({ id: "entry-1", kind: "ask" })
      const finished = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, { working: false, lastTurn: turn() }, "codex"),
      )
      const [first] = inboxEntries(
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
      const entries = inboxEntries(
        inputs(asking, {
          messages: heldFor([waiting()], "asking"),
          requests: { "02": [asked("r1", 0)] },
          now: at,
        }),
      )
      expect(entries.map(({ kind }) => kind).toSorted()).toEqual(["request", "trouble"])
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
      const entries = inboxEntries(
        inputs(both, { unread: done, requests: { "01": [asked("r1", 5)] } }),
      )

      expect(entries.map((entry) => entry.id)).toEqual(["request:r1"])
    })

    it("keeps a held thread beside the terminal's other entry", () => {
      const pair = workspaceOf(
        agentTerminal(1, {
          working: false,
          lastTurn: turn({ outcome: "failed", error: "x" }),
        }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const entries = inboxEntries(inputs(pair, { unread: failed, messages: messagesOf(thread()) }))

      expect(entries.map((entry) => entry.id)).toEqual(["trouble:01:100", "held:th1"])
    })

    it("shows every held thread, the newest first", () => {
      const both = workspaceOf(
        agentTerminal(1, { working: false }),
        agentTerminal(2, { working: false }, "codex"),
      )
      const messages: MessagesState = {
        ...noMessages,
        terminals: {
          "p/s/01": {
            terminalId: "01",
            handle: "moth",
            agent: true,
            threads: [
              thread({ id: "newer", messages: [message({ sentAt: 90 })] }),
              thread({ id: "older", messages: [message({ sentAt: 20 })] }),
            ],
          },
        },
      }

      expect(inboxEntries(inputs(both, { messages })).map((entry) => entry.id)).toEqual([
        "held:newer",
        "held:older",
      ])
    })
  })

  describe("the whole list", () => {
    it("orders the newest first", () => {
      const workspace = workspaceOf(
        agentTerminal(1, { working: false, lastTurn: turn({ at: 10, reply: "a" }) }),
        agentTerminal(2, { working: true, attention: { kind: "permission", count: 1 } }),
        agentTerminal(3, { working: false, lastTurn: turn({ at: 5, outcome: "failed" }) }),
        agentTerminal(4, { working: false }, "zsh"),
      )
      const entries = inboxEntries(
        inputs(workspace, {
          unread: { "p/s": { "01": "done", "03": "failed" } },
          requests: { "02": [asked("r1", 20)] },
        }),
      )

      expect(entries.map((entry) => entry.id)).toEqual(["request:r1", "trouble:03:5"])
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
      const entries = inboxEntries(
        inputs(workspaceOf(shell, agentTerminal(2, { working: false, lastTurn: turn() })), {
          unread: { "p/s": { "01": "done", "02": "done" } },
        }),
      )

      expect(entries).toEqual([])
    })
  })

  describe("an entry", () => {
    const attention: AgentStatus = { working: true, attention: { kind: "permission", count: 1 } }
    const told = (id = "told-1", at = 4000, settled?: WrittenEntry["settled"]): WrittenEntry =>
      written({
        id,
        at,
        content: { kind: "tell", subject: "Preview ready", body: "Open the preview." },
        ...(settled && { settled }),
      })

    it("derives whether an ask waits from the agent's current working state", () => {
      for (const agent of ["claude", "codex", "agy"] as const) {
        for (const working of [true, false]) {
          const entries = inboxEntries(
            inputs(workspaceOf(agentTerminal(1, { working }, agent)), {
              entries: [written({ agent })],
            }),
          )
          expect(entries[0]).toMatchObject({ kind: "ask", stopped: !working, source: { agent } })
        }
      }
    })

    it("lists a settled ask as a settled entry, stopped false, whatever its terminal's agent does now", () => {
      const settled = written({ settled: { how: "dismissed", at: 5000 } })
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
        expect(inboxEntries(inputs(workspaceOf(terminal), { entries: [settled] }))).toMatchObject([
          { id: "entry-1", kind: "ask", stopped: false, settled: { how: "dismissed", at: 5000 } },
        ])
      }
      // An open ask of an agent that is no longer there is dropped, a settled one is not; neither
      // outlives its terminal.
      const other = workspaceOf(agentTerminal(1, { working: false }, "codex"))
      expect(inboxEntries(inputs(other, { entries: [written()] }))).toEqual([])
      // A resolved one outlives its terminal, under its project, whose it was named.
      expect(inboxEntries(inputs(workspaceOf(), { entries: [settled] }))).toMatchObject([
        { id: "entry-1", source: { handle: "moth", title: "Closed terminal", projectName: "App" } },
      ])
      const nowhere = { ...settled, projectId: "other" }
      expect(inboxEntries(inputs(workspaceOf(), { entries: [nowhere] }))).toEqual([])
    })

    it("lists resolved entries with the rest, the newest first by when each was added", () => {
      const given = [
        written({ id: "old", at: 1000, settled: { how: "dismissed", at: 6000 } }),
        written({ id: "new", at: 4000, settled: { how: "replied", at: 9000 } }),
        told("told", 2000),
        written({ id: "open", at: 3000 }),
      ]
      const entries = inboxEntries(
        inputs(workspaceOf(agentTerminal(1, { working: false })), { entries: given }),
      )
      expect(entries.map(({ id }) => id)).toEqual(["new", "open", "told", "old"])
    })

    it("lists a read tell as resolved", () => {
      const given = [told("read", 2000, { how: "read", at: 3000 })]
      const [entry] = inboxEntries(
        inputs(workspaceOf(agentTerminal(1, { working: false })), { entries: given }),
      )
      expect(entry?.settled).toEqual({ how: "read", at: 3000 })
    })

    it("keeps an unread tell after its agent exits, with its original attribution", () => {
      const exited: TerminalMetadata = {
        ...agentTerminal(1),
        state: "exited",
        exitCode: 0,
        signal: null,
      }
      const entries = inboxEntries(inputs(workspaceOf(exited), { entries: [written(), told()] }))
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        id: "told-1",
        kind: "update",
        stopped: false,
        source: { agent: "claude", handle: "moth" },
        update: { type: "told" },
      })
      expect(inboxEntries(inputs(workspaceOf(), { entries: [told()] }))).toEqual([])
    })

    it("lists a current permission or plan and an older stopped MCP ask, each its own entry", () => {
      for (const kind of ["permission", "plan"] as const) {
        const request = asked("gate", 8000)
        const waiting = workspaceOf(
          agentTerminal(1, { working: false, attention: { kind, count: 1 } }),
        )
        const entries = inboxEntries(
          inputs(waiting, {
            entries: [written()],
            requests: { "01": [{ ...request, request: { ...request.request, kind } }] },
          }),
        )
        expect(entries.map(({ id }) => id).toSorted()).toEqual(["entry-1", "request:gate"])
      }
    })

    it("keeps a gate's unread dialog grace for the request's entry, not for the ask beside it", () => {
      const waiting = workspaceOf(agentTerminal(1, attention))
      for (const requests of [{}, { "01": [asked("gate", 9500, null)] }]) {
        const entries = inboxEntries(inputs(waiting, { entries: [written()], requests }))
        expect(entries.map(({ id }) => id)).toEqual(["entry-1"])
      }
    })

    it("lists a stopped question and an MCP ask beside it", () => {
      const question = asked("question", 8000)
      const waiting = workspaceOf(
        agentTerminal(1, { working: false, attention: { kind: "question", count: 1 } }),
      )
      const entries = inboxEntries(
        inputs(waiting, {
          entries: [written()],
          requests: { "01": [{ ...question, request: { ...question.request, kind: "question" } }] },
        }),
      )
      expect(entries.map(({ id }) => id).toSorted()).toEqual(["entry-1", "request:question"])
    })

    it("lists two tells from one terminal, the newer first", () => {
      const entries = inboxEntries(
        inputs(workspaceOf(agentTerminal(1, { working: false })), {
          entries: [
            { ...told("merged"), at: 20 },
            { ...told("opened"), at: 10 },
          ],
        }),
      )
      expect(entries.map(({ id }) => id)).toEqual(["merged", "opened"])
    })

    it("lists an ask beside the tells of the same terminal, and not its completed turn", () => {
      const entries = inboxEntries(
        inputs(workspaceOf(agentTerminal(1, { working: false, lastTurn: turn() })), {
          unread: done,
          entries: [written({ id: "ask" }), told("t1"), told("t2")],
        }),
      )
      expect(entries.map(({ id }) => id).toSorted()).toEqual(["ask", "t1", "t2"])
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
          inboxEntries(inputs(workspaceOf(agentTerminal(1)), { entries: [written(change)] })),
        ).toEqual([])
      }
    })
  })
})
