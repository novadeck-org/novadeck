import { handleNames, runningLeads, terminalOrigins } from "./derivations"
import { workspaceReducer } from "./state"
import { describe, expect, it } from "./test"
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
