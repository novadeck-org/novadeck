import { workspaceReducer } from "../model/state"
import { describe, expect, it } from "../test"
import { workspaceFixture } from "../test/fixtures"
import { runningLeads } from "./selectors"

const target = { projectId: "project", workspaceSessionId: "initial" }

// Terminal 02 is led by terminal 01, whose handle is t1.
const led = () => {
  const workspace = workspaceFixture({ terminals: 2 })
  return [
    { type: "terminal/update", target, terminalId: "01", handle: "t1" },
    { type: "terminal/update", target, terminalId: "02", handle: "t2", ledBy: "t1" },
  ].reduce(
    (state, action) => workspaceReducer(state, action as Parameters<typeof workspaceReducer>[1]),
    workspace,
  )
}

describe("the leads that run", () => {
  it("name the lead of a terminal while the lead's terminal is live", () => {
    expect(runningLeads(led())).toEqual({ "02": { handle: "t1", name: "Terminal 01" } })
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
    expect(runningLeads(back)).toEqual({ "02": { handle: "t1", name: "Terminal 01" } })
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
