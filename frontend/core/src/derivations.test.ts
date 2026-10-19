import {
  handleNames,
  runningLeads,
  sameTeam,
  teamOf,
  teamRole,
  terminalOrigins,
} from "./derivations"
import { workspaceReducer } from "./state"
import { context, describe, expect, it } from "./test"
import { terminalFixture, workspaceFixture } from "./testing"

const target = { projectId: "project", workspaceSessionId: "initial" }

// The second terminal is led by the first, whose handle is moth.
const led = () => {
  const workspace = workspaceFixture({ terminals: 2 })
  return [
    { type: "terminal/update", target, terminalId: "01", handle: "moth" },
    { type: "terminal/update", target, terminalId: "02", handle: "fox", ledBy: "moth" },
  ].reduce(
    (state, action) => workspaceReducer(state, action as Parameters<typeof workspaceReducer>[1]),
    workspace,
  )
}

describe("the leads that run", () => {
  it("name the lead of a terminal while the lead's terminal is live", () => {
    expect(runningLeads(led())).toEqual({ "02": { handle: "moth", name: "Terminal" } })
  })

  it("leave a terminal without one once its lead exits, and bring it back as the lead runs again", () => {
    const exited = workspaceReducer(led(), {
      type: "terminal/status",
      target,
      terminalId: "01",
      status: { state: "exited", exitCode: 0, signal: null },
    })
    expect(runningLeads(exited)).toEqual({})
    const back = workspaceReducer(exited, {
      type: "terminal/status",
      target,
      terminalId: "01",
      status: { state: "idle" },
    })
    expect(runningLeads(back)).toEqual({ "02": { handle: "moth", name: "Terminal" } })
  })

  it("name the first live terminal with the lead's handle, passing over one that exited", () => {
    const shared = [
      { type: "terminal/add", target, terminal: terminalFixture(3, "~/project") },
      { type: "terminal/update", target, terminalId: "03", handle: "moth" },
      { type: "terminal/rename", target, terminalId: "03", name: "Other" },
    ].reduce(
      (state, action) => workspaceReducer(state, action as Parameters<typeof workspaceReducer>[1]),
      led(),
    )
    expect(runningLeads(shared)).toEqual({ "02": { handle: "moth", name: "Terminal" } })
    const exited = workspaceReducer(shared, {
      type: "terminal/status",
      target,
      terminalId: "01",
      status: { state: "exited", exitCode: 0, signal: null },
    })
    expect(runningLeads(exited)).toEqual({ "02": { handle: "moth", name: "Other" } })
  })

  it("leave a terminal without one once its lead is closed", () => {
    const closed = workspaceReducer(led(), { type: "terminal/close", target, terminalId: "01" })
    expect(runningLeads(closed)).toEqual({})
  })

  it("leave a terminal without one once its stored lead ends", () => {
    const ended = workspaceReducer(led(), {
      type: "terminal/update",
      target,
      terminalId: "02",
      ledBy: null,
    })
    expect(runningLeads(ended)).toEqual({})
  })
})

// moth (01) leads fox (02) and owl (04); wren (03) works alone; owl leads newt (05) in turn.
const teams = () =>
  [
    ...[3, 4, 5].map((slot) => ({
      type: "terminal/add",
      target,
      terminal: terminalFixture(slot, "~/project"),
    })),
    { type: "terminal/update", target, terminalId: "03", handle: "wren" },
    { type: "terminal/update", target, terminalId: "04", handle: "owl", ledBy: "moth" },
    { type: "terminal/update", target, terminalId: "05", handle: "newt", ledBy: "owl" },
  ].reduce(
    (state, action) => workspaceReducer(state, action as Parameters<typeof workspaceReducer>[1]),
    led(),
  )

const select = (workspace: ReturnType<typeof led>, terminalId: string) =>
  workspaceReducer(workspace, { type: "terminal/select", target, terminalId })

describe("a terminal's team", () => {
  context("when it leads", () => {
    it("is the team it leads, its workers in the order they were opened", () => {
      expect(teamOf(teams(), "01")).toEqual({ lead: "01", workers: ["02", "04"] })
    })
  })

  context("when it works for a lead", () => {
    it("is its lead's team", () => {
      expect(teamOf(teams(), "02")).toEqual({ lead: "01", workers: ["02", "04"] })
    })
  })

  context("when it both works for a lead and leads", () => {
    it("is the team it leads", () => {
      expect(teamOf(teams(), "04")).toEqual({ lead: "04", workers: ["05"] })
    })
  })

  context("when it is in no team", () => {
    it("is none", () => {
      expect(teamOf(teams(), "03")).toBeUndefined()
    })
  })

  context("when two live terminals share its lead's handle", () => {
    it("is led by the first of them", () => {
      const shared = [
        { type: "terminal/add", target, terminal: terminalFixture(6, "~/project") },
        { type: "terminal/update", target, terminalId: "06", handle: "moth" },
      ].reduce(
        (state, action) =>
          workspaceReducer(state, action as Parameters<typeof workspaceReducer>[1]),
        teams(),
      )
      expect(teamOf(shared, "02")?.lead).toBe("01")
      expect(teamOf(shared, "06")).toBeUndefined()
    })
  })

  context("when its lead exits", () => {
    it("is none for its workers", () => {
      const exited = workspaceReducer(led(), {
        type: "terminal/status",
        target,
        terminalId: "01",
        status: { state: "exited", exitCode: 0, signal: null },
      })
      expect(teamOf(exited, "01")).toBeUndefined()
      expect(teamOf(exited, "02")).toBeUndefined()
    })
  })
})

describe("two teams", () => {
  it("are the same while the lead and its workers are, though a terminal elsewhere changed", () => {
    const before = teams()
    const renamed = workspaceReducer(before, {
      type: "terminal/rename",
      target,
      terminalId: "03",
      name: "Elsewhere",
    })
    const [a, b] = [teamOf(before, "01"), teamOf(renamed, "01")]
    expect(a).not.toBe(b)
    expect(sameTeam(a, b)).toBe(true)
  })

  it("differ once a worker joins", () => {
    const joined = workspaceReducer(teams(), {
      type: "terminal/update",
      target,
      terminalId: "03",
      ledBy: "moth",
    })
    expect(sameTeam(teamOf(teams(), "01"), teamOf(joined, "01"))).toBe(false)
  })
})

describe("a terminal's role in the selected team", () => {
  it("is lead or worker for the selected worker's team, and nothing outside it", () => {
    const selected = select(teams(), "02")
    expect(["01", "02", "03", "04", "05"].map((id) => teamRole(selected, id))).toEqual([
      "lead",
      "worker",
      undefined,
      "worker",
      undefined,
    ])
  })

  it("is lead or worker for the team the selected terminal leads, when it also works for a lead", () => {
    const selected = select(teams(), "04")
    expect(["01", "02", "03", "04", "05"].map((id) => teamRole(selected, id))).toEqual([
      undefined,
      undefined,
      undefined,
      "lead",
      "worker",
    ])
  })

  it("is nothing anywhere while the selected terminal is in no team", () => {
    const selected = select(teams(), "03")
    expect(["01", "02", "03", "04", "05"].map((id) => teamRole(selected, id))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })
})

describe("the roster-wide values", () => {
  const values = (workspace: ReturnType<typeof led>) => [
    runningLeads(workspace),
    terminalOrigins(workspace),
    handleNames(workspace),
  ]

  it("hand every reader the same value while the roster stays, whatever else changes", () => {
    const before = led()
    const selected = workspaceReducer(before, { type: "terminal/select", target, terminalId: "02" })
    values(selected).forEach((value, index) => expect(value).toBe(values(before)[index]))
  })

  it("follow the roster once it changes", () => {
    const renamed = workspaceReducer(led(), {
      type: "terminal/rename",
      target,
      terminalId: "01",
      name: "Lead",
    })
    expect(values(renamed)).toEqual([
      { "02": { handle: "moth", name: "Lead" } },
      { "01": "@moth · Lead", "02": "@fox · Terminal" },
      { moth: "Lead", fox: "Terminal" },
    ])
  })
})
