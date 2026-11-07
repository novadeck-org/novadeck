import { terminalFixture, workspaceFixture } from "@novadeck/core/testing"
import type {
  AgentStatus,
  TerminalMetadata,
  WorkspaceProject,
  WorkspaceSession,
} from "@novadeck/core/types"

import { projectStatus } from "../projects/project-status"
import { context, describe, expect, it } from "../test"
import { elsewhereSessionsText, sessionMarks, sessionNeedText } from "./session-marks"

const now = 1_000_000
const noUnread = () => undefined

const agentIn = (
  number: number,
  agent: Partial<AgentStatus>,
  extra: Partial<TerminalMetadata> = {},
): TerminalMetadata =>
  ({
    ...terminalFixture(number, "~/project"),
    state: "running",
    handle: `h${number}`,
    agent: { working: false, ...agent },
    ...extra,
  }) as TerminalMetadata
const needs = (number: number, extra: Partial<TerminalMetadata> = {}) =>
  agentIn(number, { attention: { kind: "permission", count: 1 } }, extra)
const asks = (number: number, extra: Partial<TerminalMetadata> = {}) =>
  agentIn(number, { attention: { kind: "question", count: 1 } }, extra)

// A project whose sessions hold these terminals, ids `s1`, `s2`, ...
const projectOf = (...sessions: TerminalMetadata[][]): WorkspaceProject => {
  const base = workspaceFixture().projects[0]!
  const first = base.history[0]!
  const history: WorkspaceSession[] = sessions.map((terminals, index) => ({
    ...first,
    id: `s${index + 1}`,
    state: { ...first.state, roster: { ...first.state.roster, terminals } },
  }))
  return { ...base, history, activeSessionId: "s1" }
}
const marksOf = (project: WorkspaceProject) => sessionMarks(project, noUnread, [], now)

describe("A session's mark", () => {
  context("when its terminals show different things", () => {
    it("is the most pressing of this session's own, not the project's", () => {
      const project = projectOf(
        [agentIn(1, { working: true }), asks(2)],
        [agentIn(3, { working: true })],
        [needs(4)],
      )
      const marks = marksOf(project)
      expect(marks.s1!.status).toBe("ask")
      expect(marks.s2!.status).toBe("running")
      expect(marks.s3!.status).toBe("unblock")
      expect(projectStatus(project, noUnread, [], now)).toBe("unblock")
    })

    it("counts what needs the person and what asks", () => {
      const marks = marksOf(projectOf([needs(1), needs(2), asks(3), agentIn(4, {})]))
      expect(marks.s1).toMatchObject({ needsYou: 2, asks: 1 })
    })

    it("reads the same for a Codex or Antigravity terminal as for Claude Code", () => {
      for (const process of ["claude", "codex", "agy"])
        expect(marksOf(projectOf([needs(1, { process })])).s1!.status).toBe("unblock")
    })
  })

  context("when nothing shows", () => {
    it("has no status, and an agent asleep counts as idle", () => {
      const sleeping = agentIn(1, {}, { state: "sleeping" })
      const mark = marksOf(projectOf([sleeping, terminalFixture(2, "~")])).s1!
      expect(mark.status).toBeUndefined()
      expect(mark.lines).toEqual([])
      expect(sessionNeedText(mark)).toBeUndefined()
    })
  })

  context("when it names the terminals that need the person", () => {
    it("lists those that need them before those that ask, up to three, then the rest", () => {
      const marks = marksOf(
        projectOf(
          [asks(1, { name: "A" }), needs(2, { name: "B" }), needs(3, { name: "C" })],
          [
            needs(4, { name: "D" }),
            needs(5, { name: "E" }),
            asks(6, { name: "F" }),
            asks(7, { name: "G" }),
          ],
        ),
      )
      expect(marks.s1!.lines).toEqual(["Needs you: @h2 · B", "Needs you: @h3 · C", "Asks: @h1 · A"])
      expect(marks.s2!.lines).toEqual([
        "Needs you: @h4 · D",
        "Needs you: @h5 · E",
        "Asks: @h6 · F",
        "and 1 more",
      ])
    })
  })
})

describe("A session's detail words", () => {
  it("lead with the most pressing count", () => {
    const text = (...terminals: TerminalMetadata[]) =>
      sessionNeedText(marksOf(projectOf(terminals)).s1)
    expect(text(needs(1), asks(2))).toBe("1 needs you")
    expect(text(asks(1), asks(2))).toBe("2 asks")
    expect(text(agentIn(1, { reported: true }))).toBe("1 done")
    expect(text(agentIn(1, { working: true }))).toBeUndefined()
  })
})

describe("What the other sessions ask", () => {
  const marks = marksOf(projectOf([needs(1)], [needs(2), asks(3)], [agentIn(4, { working: true })]))
  it("leaves out the open session", () => {
    expect(elsewhereSessionsText(marks, "s1")).toBe("1 needs you · 1 asks")
    expect(elsewhereSessionsText(marks, "s2")).toBe("1 needs you")
    expect(elsewhereSessionsText(marks, "s3")).toBe("2 needs you · 1 asks")
  })
  it("is none while only the open session asks", () => {
    expect(elsewhereSessionsText(marksOf(projectOf([needs(1)], [])), "s1")).toBeUndefined()
  })
})
