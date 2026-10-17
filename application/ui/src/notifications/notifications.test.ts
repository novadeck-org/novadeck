import type { AgentStatus, TerminalMetadata, WorkspaceProject } from "../model/types"
import { noUnread, type Unread } from "../terminals/unread-state"
import { context, describe, expect, it } from "../test"
import { terminalFixture, workspaceFixture } from "../test/fixtures"
import {
  dismissable,
  notificationDescription,
  notificationTooltip,
  notifications,
  type Notification,
} from "./notifications"

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
        handle: "moth",
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
          handle: "moth",
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

  context("when murmur wrote words for what the agents say", () => {
    it("puts a question's or a plan's headline in the status, keeping how many wait", () => {
      const question = running(1, {
        attention: { kind: "question", count: 2, headline: "Asks which database to use" },
      })
      const plan = running(2, {
        attention: { kind: "plan", count: 1, headline: "Plan to split billing" },
      })
      expect(notifications([project("a", [question, plan])], noUnread)).toMatchObject([
        { kind: "question", status: "Asks which database to use · 2 waiting", headline: true },
        { kind: "plan", status: "Plan to split billing", headline: true },
      ])
    })

    it("leaves a permission as it is", () => {
      const permission = running(1, {
        attention: { kind: "permission", count: 1, headline: "Asks to run rm" },
      })
      const [notification] = notifications([project("a", [permission])], noUnread)
      expect(notification).toMatchObject({ kind: "permission", status: "Needs permission" })
      expect(notification).not.toHaveProperty("headline")
    })

    it("carries a finish's gist, and that it asks, without changing its kind or order", () => {
      const asks = running(1, {
        lastTurn: {
          outcome: "completed",
          at: 100,
          reply: "Rounded. Want me to split it?",
          gist: "Rounded totals per line",
          asks: true,
        },
      })
      const plain = running(2, {
        lastTurn: { outcome: "failed", at: 200, reply: "No build.", gist: "Build is broken" },
      })
      const unread: Unread = {
        "a/initial": { [asks.id]: "done", [plain.id]: "failed" },
      }
      const [first, second] = notifications([project("a", [asks, plain])], unread)
      expect(first).toMatchObject({ kind: "failed", gist: "Build is broken", reply: "No build." })
      expect(first).not.toHaveProperty("asks")
      expect(second).toMatchObject({
        kind: "done",
        status: "Done · reply unread",
        gist: "Rounded totals per line",
        asks: true,
        reply: "Rounded. Want me to split it?",
      })
    })

    it("shows a gist only on a finish", () => {
      const both = running(1, {
        attention: { kind: "question", count: 1 },
        lastTurn: { outcome: "completed", at: 1, gist: "Rounded", asks: true },
      })
      const [notification] = notifications([project("a", [both])], {
        "a/initial": { [both.id]: "done" },
      })
      expect(notification).not.toHaveProperty("gist")
      expect(notification).not.toHaveProperty("asks")
      expect(notification).not.toHaveProperty("headline")
    })

    it("leaves every row as it was without murmur", () => {
      const question = running(1, { attention: { kind: "question", count: 1 } })
      const done = finished(2, 5, "All green.")
      const rows = notifications([project("a", [question, done])], {
        "a/initial": { [done.id]: "done" },
      })
      expect(
        rows.map(({ status, headline, gist, asks }) => [status, headline, gist, asks]),
      ).toEqual([
        ["Asks a question", undefined, undefined, undefined],
        ["Done · reply unread", undefined, undefined, undefined],
      ])
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

describe("The notification list", () => {
  const asked = () => [project("p", [running(1, { attention: { kind: "question", count: 1 } })])]

  it("is the same list for every reader of one workspace and one set of unread marks", () => {
    const projects = asked()
    expect(notifications(projects, noUnread)).toBe(notifications(projects, noUnread))
  })

  it("is scanned afresh once the workspace or the unread marks change", () => {
    const projects = asked()
    const first = notifications(projects, noUnread)
    const unread: Unread = { "p/initial": {} }
    expect(notifications(projects, unread)).not.toBe(first)
    expect(notifications(projects, unread)).toEqual(first)
    expect(notifications([...projects], noUnread)).not.toBe(first)
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

const item = (rest: Partial<Notification>): Notification => ({
  kind: "done",
  context: "p/initial",
  projectId: "p",
  projectName: "docs-site",
  sessionId: "initial",
  sessionName: "Main",
  terminalId: "t",
  terminalName: "Checkout",
  status: "Done · reply unread",
  ...rest,
})

describe("What a notification says in words", () => {
  it("reads status, where, that it asks, and the reply, as sentences", () => {
    const asks = item({ reply: "Rounded. Want me to split it?", asks: true, gist: "Rounded" })
    expect(notificationDescription(asks)).toBe(
      "Done · reply unread. docs-site · Main. Asks you something. Rounded. Want me to split it?",
    )
    expect(notificationDescription(item({}))).toBe("Done · reply unread. docs-site · Main")
  })

  it("adds no full stop after a headline that ends in a mark", () => {
    expect(
      notificationDescription(item({ kind: "question", status: "Asks which database?" })),
    ).toBe("Asks which database? docs-site · Main")
  })

  it("keeps the asking and the raw reply in the tooltip, a line each", () => {
    const asks = item({ reply: "Rounded. Want me to split it?", asks: true, gist: "Rounded" })
    expect(notificationTooltip(asks)).toBe(
      "Checkout\nDone · reply unread\ndocs-site · Main\nAsks you something\nRounded. Want me to split it?",
    )
    expect(notificationTooltip(item({}))).toBe("Checkout\nDone · reply unread\ndocs-site · Main")
  })
})
