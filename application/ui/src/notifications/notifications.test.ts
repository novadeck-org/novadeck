import type { AgentStatus, TerminalMetadata, WorkspaceProject } from "../model/types"
import { noUnread, type Unread } from "../terminals/unread-state"
import { context, describe, expect, it } from "../test"
import { terminalFixture, workspaceFixture } from "../test/fixtures"
import { dismissable, notifications } from "./notifications"

const running = (number: number, status?: Partial<AgentStatus>): TerminalMetadata => ({
  ...terminalFixture(number, "~/project"),
  state: "running",
  ...(status ? { agent: { working: false, ...status } } : {}),
})

const finished = (number: number, at: number, reply?: string): TerminalMetadata =>
  running(number, {
    lastTurn: { outcome: "completed", at, ...(reply ? { reply } : {}) },
  })

// The fixture's project with these terminals in its one session, `initial`.
const project = (id: string, terminals: TerminalMetadata[]): WorkspaceProject => {
  const base = workspaceFixture().projects[0]!
  const session = base.history[0]!
  return {
    ...base,
    id,
    name: `Project ${id}`,
    history: [
      { ...session, state: { ...session.state, roster: { ...session.state.roster, terminals } } },
    ],
  }
}

const kinds = (projects: WorkspaceProject[], unread: Unread) =>
  notifications(projects, unread).map(({ kind, terminalId }) => [kind, terminalId])

describe("The notification center", () => {
  context("when nothing asks for the person", () => {
    it("lists nothing, for a working agent, an idle one and a plain shell", () => {
      const terminals = [running(1, { working: true }), running(2, {}), running(3)]
      expect(notifications([project("p", terminals)], noUnread)).toEqual([])
    })
  })

  context("when agents wait on the person across projects", () => {
    it("lists each by what it asks, questions first, in workspace order", () => {
      const permission = running(1, { attention: { kind: "permission", count: 1 } })
      const plan = running(2, { attention: { kind: "plan", count: 1 } })
      const question = running(3, { attention: { kind: "question", count: 2 } })
      const other = running(4, { attention: { kind: "permission", count: 1 } })
      expect(
        kinds([project("a", [permission, plan, question]), project("b", [other])], noUnread),
      ).toEqual([
        ["question", question.id],
        ["permission", permission.id],
        ["permission", other.id],
        ["plan", plan.id],
      ])
    })

    it("says where each is and what it asks, in the tab's words", () => {
      const question = {
        ...running(1, { attention: { kind: "question", count: 2 } }),
        handle: "t1",
      }
      expect(notifications([project("a", [question])], noUnread)).toEqual([
        {
          kind: "question",
          context: "a/initial",
          projectId: "a",
          projectName: "Project a",
          sessionId: "initial",
          sessionName: expect.any(String),
          terminalId: question.id,
          terminalName: question.name,
          handle: "t1",
          status: "Asks a question · 2 waiting",
        },
      ])
    })
  })

  context("when agents finished while the person looked elsewhere", () => {
    it("lists failures before finishes, the latest of each first, after the requests", () => {
      const early = finished(1, 100)
      const late = finished(2, 300)
      const failed = finished(3, 200)
      const asking = running(4, { attention: { kind: "plan", count: 1 } })
      const unread: Unread = {
        "a/initial": { [early.id]: "done", [late.id]: "done" },
        "b/initial": { [failed.id]: "failed" },
      }
      expect(kinds([project("a", [early, late]), project("b", [failed, asking])], unread)).toEqual([
        ["plan", asking.id],
        ["failed", failed.id],
        ["done", late.id],
        ["done", early.id],
      ])
    })

    it("carries the start of the agent's last reply", () => {
      const done = finished(1, 100, "All tests pass.")
      const [notification] = notifications([project("a", [done])], {
        "a/initial": { [done.id]: "done" },
      })
      expect(notification).toMatchObject({
        status: "Done · reply unread",
        reply: "All tests pass.",
      })
    })
  })

  context("when a terminal both waits on the person and has a reply unread", () => {
    it("lists it once, by what it asks", () => {
      const both = running(1, { attention: { kind: "permission", count: 1 } })
      expect(kinds([project("a", [both])], { "a/initial": { [both.id]: "done" } })).toEqual([
        ["permission", both.id],
      ])
    })
  })

  context("when a terminal with a reply unread has ended", () => {
    it("lists nothing, as its tab reads ended", () => {
      const ended: TerminalMetadata = {
        ...terminalFixture(1, "~/project"),
        state: "exited",
        exitCode: 1,
        signal: null,
      }
      expect(
        notifications([project("a", [ended])], { "a/initial": { [ended.id]: "failed" } }),
      ).toEqual([])
    })
  })
})

describe("Dismissing a notification", () => {
  it("clears a finish, but not a request still waiting on the person", () => {
    expect(dismissable("done")).toBe(true)
    expect(dismissable("failed")).toBe(true)
    expect(dismissable("question")).toBe(false)
    expect(dismissable("permission")).toBe(false)
    expect(dismissable("plan")).toBe(false)
  })
})
