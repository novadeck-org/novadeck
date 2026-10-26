import type { InboxRow } from "@novadeck/core/inbox"
import { terminalFixture, workspaceFixture } from "@novadeck/core/testing"
import type { AgentStatus, TerminalMetadata, WorkspaceProject } from "@novadeck/core/types"

import { context, describe, expect, it } from "../test"
import {
  anyAgentWorking,
  elsewhereStatus,
  projectStatus as statusOf,
  projectStatuses as statusesOf,
} from "./project-status"

// Unread ends by session context, then terminal id, as the app keeps them.
type Unread = Readonly<Record<string, Readonly<Record<string, "unread" | "failed">>>>
const noUnread: Unread = {}
const projectStatus = (project: WorkspaceProject, unread: Unread, items: InboxRow[] = []) =>
  statusOf(project, (session, id) => unread[session]?.[id], items, now)
const projectStatuses = (projects: WorkspaceProject[], unread: Unread, items: InboxRow[] = []) =>
  statusesOf(projects, (session, id) => unread[session]?.[id], items, now)

const now = 1_000_000

// An item of this terminal in the Inbox, as the backend lists it.
const itemOf = (
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
const askItem = (projectId: string, terminal: TerminalMetadata, type: "text" | "action") =>
  itemOf(projectId, terminal, {
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
const doneItem = (projectId: string, terminal: TerminalMetadata, seen = false) =>
  itemOf(
    projectId,
    terminal,
    { kind: "update", update: { type: "done", subject: "Done", body: "" } },
    { seen },
  )

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
      const finished = running(2, {})
      const failed = running(3, {})
      const waiting = running(4, {
        attention: { kind: "permission", count: 1 },
      })
      const asking = running(5, { attention: { kind: "question", count: 1 } })
      const ends: Unread = {
        "p/initial": { [finished.id]: "unread", [failed.id]: "failed" },
      }
      expect(projectStatus(project("p", [working]), ends)).toBe("running")
      // A bare end reads unread, which no status marks; a done report does.
      expect(projectStatus(project("p", [working, finished]), ends)).toBe("running")
      expect(
        projectStatus(project("p", [working, finished]), ends, [doneItem("p", finished)]),
      ).toBe("done")
      expect(projectStatus(project("p", [finished, failed, working]), ends)).toBe("failed")
      expect(projectStatus(project("p", [failed, waiting]), ends)).toBe("unblock")
      expect(projectStatus(project("p", [waiting, asking, failed]), ends)).toBe("unblock")
      // Without the permission, the question outranks a failure.
      expect(projectStatus(project("p", [asking, failed]), ends)).toBe("ask")
    })

    it("counts the Inbox's needs as its tabs mark them: an ask a question, an action needs you", () => {
      const asking = running(1, {})
      const signing = running(2, {})
      expect(projectStatus(project("p", [asking]), noUnread, [askItem("p", asking, "text")])).toBe(
        "ask",
      )
      expect(
        projectStatus(project("p", [asking, signing]), noUnread, [
          askItem("p", asking, "text"),
          askItem("p", signing, "action"),
        ]),
      ).toBe("unblock")
      expect(
        projectStatus(project("p", [signing]), noUnread, [askItem("p", signing, "action")]),
      ).toBe("unblock")
      // A need counts while the agent works on, as its tab's mark does.
      const working = running(3, { working: true })
      expect(
        projectStatus(project("p", [working]), noUnread, [askItem("p", working, "text")]),
      ).toBe("ask")
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

    it("counts a done report only while unseen, and not of another project", () => {
      const finished = running(1, {})
      expect(
        projectStatus(project("p", [finished]), noUnread, [doneItem("p", finished, true)]),
      ).toBe(undefined)
      expect(projectStatus(project("p", [finished]), noUnread, [doneItem("q", finished)])).toBe(
        undefined,
      )
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
        projectStatus(project("p", [killed]), unread("p", killed.id, "failed"), [
          doneItem("p", killed),
        ]),
      ).toBeUndefined()
    })

    it("counts only an agent at work as running", () => {
      const server: TerminalMetadata = { ...running(1), process: "node" }
      expect(projectStatus(project("p", [server]), noUnread)).toBeUndefined()
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

  it("ignores projects that are only working", () => {
    expect(elsewhereStatus({ busy: "running" }, "here", [])).toBeUndefined()
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
