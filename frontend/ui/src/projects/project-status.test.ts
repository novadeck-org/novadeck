import type { InboxRow } from "@novadeck/core/inbox"
import { terminalFixture, workspaceFixture } from "@novadeck/core/testing"
import type { AgentStatus, TerminalMetadata, WorkspaceProject } from "@novadeck/core/types"

import { context, describe, expect, it } from "../test"
import {
  anyAgentWorking,
  elsewhereStatus,
  nextStatusChange,
  projectAsk as askOf,
  projectAsks as asksOf,
  projectStatus as statusOf,
  projectStatuses as statusesOf,
} from "./project-status"

// Unread ends by session context, then terminal id, as the app keeps them.
type Unread = Readonly<Record<string, Readonly<Record<string, "unread" | "failed">>>>
const noUnread: Unread = {}
const projectStatus = (project: WorkspaceProject, unread: Unread, rows: InboxRow[] = []) =>
  statusOf(project, (session, id) => unread[session]?.[id], rows, now)
const projectStatuses = (projects: WorkspaceProject[], unread: Unread, rows: InboxRow[] = []) =>
  statusesOf(projects, (session, id) => unread[session]?.[id], rows, now)
const projectAsk = (project: WorkspaceProject, unread: Unread, rows: InboxRow[] = []) =>
  askOf(project, (session, id) => unread[session]?.[id], rows, now)
const projectAsks = (projects: WorkspaceProject[], unread: Unread) =>
  asksOf(projects, (session, id) => unread[session]?.[id], [], now)

const now = 1_000_000

// An Inbox row of this terminal, as the backend lists it.
const rowOf = (
  projectId: string,
  terminal: TerminalMetadata,
  content: Pick<InboxRow, "kind"> & Record<string, unknown>,
  extra: Partial<InboxRow> = {},
): InboxRow =>
  ({
    id: `${projectId}-${terminal.id}-${content.kind}`,
    source: {
      projectId,
      workspaceSessionId: "initial",
      terminalId: terminal.id,
      handle: "fox",
      agent: "claude",
      title: "T",
      projectName: "P",
    },
    at: now,
    stopped: true,
    seen: false,
    ...content,
    ...extra,
  }) as InboxRow
const askRow = (projectId: string, terminal: TerminalMetadata, type: "text" | "action") =>
  rowOf(projectId, terminal, {
    kind: "ask",
    ask: {
      subject: "Which one?",
      body: "",
      details: null,
      hardToUndo: null,
      shape:
        type === "text"
          ? { type: "text" }
          : { type: "action", command: "x login", directory: null, doneLabel: "Done" },
    },
  })
const agent = (status: Partial<AgentStatus> = {}): AgentStatus => ({
  working: false,
  ...status,
})

const running = (number: number, status?: Partial<AgentStatus>): TerminalMetadata => ({
  ...terminalFixture(number, "~/project"),
  state: "running",
  ...(status ? { agent: agent(status) } : {}),
})

// The fixture's project with these terminals in its one session, `initial`.
const project = (id: string, terminals: TerminalMetadata[]): WorkspaceProject => {
  const base = workspaceFixture().projects[0]!
  const session = base.history[0]!
  return {
    ...base,
    id,
    history: [
      {
        ...session,
        state: {
          ...session.state,
          roster: { ...session.state.roster, terminals },
        },
      },
    ],
  }
}

// An agent paused at its usage limit, which resets later; one whose turn ended to wait on
// a job it left running; and an agent program Novadeck hears nothing from.
const paused = (number: number): TerminalMetadata =>
  running(number, {
    lastTurn: { at: now - 1, outcome: "failed", limit: { minutes: 300, resetsAt: now + 60_000 } },
  })
const resting = (number: number): TerminalMetadata =>
  running(number, {
    waiting: {
      jobs: [
        { id: "job", description: "Build", command: "pnpm build", since: now - 1, until: null },
      ],
      wake: null,
    },
  })
const unheard = (number: number): TerminalMetadata => ({ ...running(number), process: "claude" })
// An agent whose turn ended to wait for a wake-up at `at`.
const wakingAt = (number: number, at: number): TerminalMetadata =>
  running(number, { waiting: { jobs: [], wake: { at, reason: null } } })

const unread = (id: string, terminal: string, end: "unread" | "failed"): Unread => ({
  [`${id}/initial`]: { [terminal]: end },
})

describe("A project's status", () => {
  context("when nothing in it shows anything", () => {
    it("is none, for an idle agent and a plain shell", () => {
      expect(projectStatus(project("p", [running(1, {}), running(2)]), noUnread)).toBeUndefined()
    })
  })

  context("when its terminals show several things", () => {
    it("is the most pressing of them", () => {
      const working = running(1, { working: true })
      const finished = running(2, { reported: true })
      const failed = running(3, {})
      const waiting = running(4, {
        attention: { kind: "permission", count: 1 },
      })
      const asking = running(5, { attention: { kind: "question", count: 1 } })
      const ends: Unread = {
        "p/initial": { [finished.id]: "unread", [failed.id]: "failed" },
      }
      expect(projectStatus(project("p", [working]), ends)).toBe("running")
      // A bare end reads unread, which no status marks; a done report that stands does.
      expect(projectStatus(project("p", [working, running(6, {})]), ends)).toBe("running")
      // One finished terminal leaves the project working while another works on.
      expect(projectStatus(project("p", [working, finished]), ends)).toBe("running")
      expect(projectStatus(project("p", [finished, running(6, {})]), ends)).toBe("done")
      expect(projectStatus(project("p", [finished, failed, working]), ends)).toBe("failed")
      expect(projectStatus(project("p", [failed, waiting]), ends)).toBe("unblock")
      expect(projectStatus(project("p", [waiting, asking, failed]), ends)).toBe("unblock")
      // Without the permission, the question outranks a failure.
      expect(projectStatus(project("p", [asking, failed]), ends)).toBe("ask")
    })

    it("counts the Inbox's needs as its tabs mark them: an ask a question, an action needs you", () => {
      const asking = running(1, {})
      const signing = running(2, {})
      expect(projectStatus(project("p", [asking]), noUnread, [askRow("p", asking, "text")])).toBe(
        "ask",
      )
      expect(
        projectStatus(project("p", [asking, signing]), noUnread, [
          askRow("p", asking, "text"),
          askRow("p", signing, "action"),
        ]),
      ).toBe("unblock")
      expect(
        projectStatus(project("p", [signing]), noUnread, [askRow("p", signing, "action")]),
      ).toBe("unblock")
      // A need counts while the agent works on, as its tab's mark does.
      const working = running(3, { working: true })
      expect(projectStatus(project("p", [working]), noUnread, [askRow("p", working, "text")])).toBe(
        "ask",
      )
    })

    it("reads each terminal as its tab does: an agent that works again is running, not failed", () => {
      const resumed = running(1, { working: true })
      const ends: Unread = { "p/initial": { [resumed.id]: "failed" } }
      expect(projectStatus(project("p", [resumed]), ends)).toBe("running")
      const stopped = running(2, {})
      expect(
        projectStatus(project("p", [stopped]), { "p/initial": { [stopped.id]: "failed" } }),
      ).toBe("failed")
    })

    it("counts a done report while it stands, looked at or not", () => {
      expect(projectStatus(project("p", [running(1, { reported: true })]), noUnread)).toBe("done")
      expect(projectStatus(project("p", [running(1, {})]), noUnread)).toBe(undefined)
      // At work again, it is running.
      expect(
        projectStatus(project("p", [running(1, { working: true, reported: true })]), noUnread),
      ).toBe("running")
    })

    it("counts a plan to review as waiting on the person", () => {
      const planning = running(1, { attention: { kind: "plan", count: 1 } })
      expect(projectStatus(project("p", [planning]), noUnread)).toBe("unblock")
    })

    it("counts nothing from an ended terminal, though its reply went unread", () => {
      const killed: TerminalMetadata = {
        ...terminalFixture(1, "~/project"),
        state: "exited",
        exitCode: null,
        signal: "SIGKILL",
      }
      expect(
        projectStatus(project("p", [killed]), unread("p", killed.id, "failed")),
      ).toBeUndefined()
    })

    it("counts only an agent at work as running", () => {
      const server: TerminalMetadata = { ...running(1), process: "node" }
      expect(projectStatus(project("p", [server]), noUnread)).toBeUndefined()
    })

    it("reads an agent's quieter phases as its tab does: paused at its limit, waiting, unheard", () => {
      expect(projectStatus(project("p", [paused(1)]), noUnread)).toBe("paused")
      expect(projectStatus(project("p", [resting(1)]), noUnread)).toBe("waiting")
      expect(projectStatus(project("p", [unheard(1)]), noUnread)).toBe("unheard")
      // A limit hit shows over work going on elsewhere in the project; work over a wait; a
      // wait over a done report; and an agent nothing tells of under everything known.
      const working = running(2, { working: true })
      const finished = running(3, { reported: true })
      expect(projectStatus(project("p", [working, paused(1)]), noUnread)).toBe("paused")
      expect(projectStatus(project("p", [resting(1), working]), noUnread)).toBe("running")
      expect(projectStatus(project("p", [finished, resting(1)]), noUnread)).toBe("waiting")
      expect(projectStatus(project("p", [unheard(1), finished]), noUnread)).toBe("done")
      expect(projectStatus(project("p", [unheard(1), resting(2)]), noUnread)).toBe("waiting")
      // What the person is asked for still comes first.
      const ends: Unread = { "p/initial": { [finished.id]: "failed" } }
      expect(projectStatus(project("p", [paused(1), finished]), ends)).toBe("failed")
      expect(
        projectStatus(project("p", [paused(1)]), noUnread, [askRow("p", paused(1), "text")]),
      ).toBe("ask")
    })

    it("stops reading an agent as waiting once its wake-up has passed by the grace", () => {
      const grace = 2 * 60_000
      expect(projectStatus(project("p", [wakingAt(1, now - grace + 1)]), noUnread)).toBe("waiting")
      expect(projectStatus(project("p", [wakingAt(1, now - grace)]), noUnread)).toBeUndefined()
    })

    it("reads unread ends only from its own sessions", () => {
      const finished = running(1, {})
      expect(
        projectStatus(project("p", [finished]), unread("q", finished.id, "failed")),
      ).toBeUndefined()
      expect(projectStatus(project("p", [finished]), unread("p", finished.id, "failed"))).toBe(
        "failed",
      )
    })
  })

  context("as what it asks of the person", () => {
    it("is the most pressing status that does, under the quieter states its mark shows", () => {
      const finished = running(1, { reported: true })
      expect(projectAsk(project("p", [finished, paused(2)]), noUnread)).toBe("done")
      expect(projectAsk(project("p", [finished, resting(2)]), noUnread)).toBe("done")
      expect(projectAsk(project("p", [finished, running(2, { working: true })]), noUnread)).toBe(
        "done",
      )
      expect(
        projectAsk(project("p", [paused(1), resting(2), unheard(3)]), noUnread),
      ).toBeUndefined()
      expect(
        projectAsk(project("p", [finished, paused(2)]), noUnread, [askRow("p", paused(2), "text")]),
      ).toBe("ask")
      // Its mark shows the quieter state all the same.
      expect(projectStatus(project("p", [finished, paused(2)]), noUnread)).toBe("paused")
    })

    it("is kept by project, where one asks anything", () => {
      const finished = running(1, { reported: true })
      expect(
        projectAsks([project("a", [finished, paused(2)]), project("b", [resting(1)])], noUnread),
      ).toEqual({ a: "done" })
    })
  })

  context("as it changes by time alone", () => {
    it("changes once a wake-up or a job its harness gave up on passes by the grace", () => {
      const grace = 2 * 60_000
      const givenUp = running(1, {
        waiting: {
          jobs: [
            { id: "job", description: null, command: "sleep", since: now - 1, until: now + 10 },
          ],
          wake: null,
        },
      })
      expect(nextStatusChange([project("p", [wakingAt(1, now + 500)])], now)).toBe(
        now + 500 + grace,
      )
      expect(
        nextStatusChange([project("p", [wakingAt(1, now + 500)]), project("q", [givenUp])], now),
      ).toBe(now + 10 + grace)
    })

    it("never changes while nothing waits, or a job has no end", () => {
      expect(nextStatusChange([project("p", [resting(1), paused(2), unheard(3)])], now)).toBe(
        undefined,
      )
      expect(nextStatusChange([], now)).toBeUndefined()
    })
  })
})

describe("The switcher's mark", () => {
  const finished = running(1, {})
  const projects = [
    project("here", [running(1, { attention: { kind: "question", count: 1 } })]),
    project("there", [finished]),
    project("busy", [running(1, { working: true })]),
  ]
  const statuses = projectStatuses(projects, unread("there", finished.id, "failed"))

  it("is the most pressing status among the other projects", () => {
    expect(statuses).toEqual({
      here: "ask",
      there: "failed",
      busy: "running",
    })
    expect(elsewhereStatus(statuses, "here", [])).toBe("failed")
    expect(elsewhereStatus(statuses, "there", [])).toBe("ask")
  })

  it("leaves out the projects it is told to ignore", () => {
    expect(elsewhereStatus(statuses, "here", ["there"])).toBeUndefined()
  })

  it("ignores projects that are only working, paused, waiting or unheard", () => {
    expect(elsewhereStatus({ busy: "running" }, "here", [])).toBeUndefined()
    expect(elsewhereStatus({ a: "paused", b: "waiting", c: "unheard" }, "here", [])).toBeUndefined()
    expect(elsewhereStatus({ a: "paused", b: "done" }, "here", [])).toBe("done")
  })
})

describe("Whether an agent is working", () => {
  it("is so when one does in any project, and not for idle agents or a plain shell", () => {
    const idle = project("a", [running(1, {}), running(2)])
    const busy = project("b", [running(3, { working: true })])
    expect(anyAgentWorking([])).toBe(false)
    expect(anyAgentWorking([idle])).toBe(false)
    expect(anyAgentWorking([idle, busy])).toBe(true)
  })
})
