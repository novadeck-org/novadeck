import type { AgentStatus, TerminalMetadata, WorkspaceProject } from "../model/types"
import { context, describe, expect, it } from "../test"
import { terminalFixture, workspaceFixture } from "../test/fixtures"
import {
  elsewhereStatus,
  projectStatus as statusOf,
  projectStatuses as statusesOf,
} from "./project-status"

// Unread ends by session context, then terminal id, as the app keeps them.
type Unread = Readonly<Record<string, Readonly<Record<string, "done" | "failed">>>>
const noUnread: Unread = {}
const projectStatus = (project: WorkspaceProject, unread: Unread) =>
  statusOf(project, (session, id) => unread[session]?.[id])
const projectStatuses = (projects: WorkspaceProject[], unread: Unread) =>
  statusesOf(projects, (session, id) => unread[session]?.[id])

const agent = (status: Partial<AgentStatus> = {}): AgentStatus => ({ working: false, ...status })

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
      { ...session, state: { ...session.state, roster: { ...session.state.roster, terminals } } },
    ],
  }
}

const unread = (id: string, terminal: string, end: "done" | "failed"): Unread => ({
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
      const waiting = running(4, { attention: { kind: "permission", count: 1 } })
      const asking = running(5, { attention: { kind: "question", count: 1 } })
      const ends: Unread = { "p/initial": { [finished.id]: "done", [failed.id]: "failed" } }
      expect(projectStatus(project("p", [working]), ends)).toBe("running")
      expect(projectStatus(project("p", [working, finished]), ends)).toBe("done")
      expect(projectStatus(project("p", [finished, failed, working]), ends)).toBe("failed")
      expect(projectStatus(project("p", [failed, waiting]), ends)).toBe("attention")
      expect(projectStatus(project("p", [waiting, asking, failed]), ends)).toBe("question")
    })

    it("counts a plan to review as waiting on the person", () => {
      const planning = running(1, { attention: { kind: "plan", count: 1 } })
      expect(projectStatus(project("p", [planning]), noUnread)).toBe("attention")
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

    it("reads unread ends only from its own sessions", () => {
      const finished = running(1, {})
      expect(
        projectStatus(project("p", [finished]), unread("q", finished.id, "done")),
      ).toBeUndefined()
      expect(projectStatus(project("p", [finished]), unread("p", finished.id, "done"))).toBe("done")
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
  const statuses = projectStatuses(projects, unread("there", finished.id, "done"))

  it("is the most pressing status among the other projects", () => {
    expect(statuses).toEqual({ here: "question", there: "done", busy: "running" })
    expect(elsewhereStatus(statuses, "here", [])).toBe("done")
    expect(elsewhereStatus(statuses, "there", [])).toBe("question")
  })

  it("leaves out the projects it is told to ignore", () => {
    expect(elsewhereStatus(statuses, "here", ["there"])).toBeUndefined()
  })

  it("ignores projects that are only working", () => {
    expect(elsewhereStatus({ busy: "running" }, "here", [])).toBeUndefined()
  })
})
