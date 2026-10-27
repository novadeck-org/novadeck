import type { BackendAction } from "@novadeck/core/port"
import type { Workspace } from "@novadeck/core/types"

import { approvalGroups, createDemoApprovals } from "./approvals"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

const key = (terminalId: string) => ({ projectId: "p", workspaceSessionId: "s", terminalId })
const terminal = (id: string) => ({
  id,
  state: "running",
  process: "claude",
  handle: id === "b" ? "bee" : "ay",
})
const workspace = {
  projects: [
    {
      id: "p",
      history: [{ id: "s", state: { roster: { terminals: [terminal("a"), terminal("b")] } } }],
    },
  ],
} as unknown as Workspace

const setup = () => {
  const dispatched: BackendAction[] = []
  const notes: string[] = []
  const controls = createDemoApprovals(
    () => (actions) => dispatched.push(...actions),
    () => workspace,
  )
  const [group] = approvalGroups(controls, () => workspace)
  const run = (label: string, selected = true) =>
    void group!.actions
      .find((action) => action.label === label)!
      .run({
        selected: () => (selected ? key("a") : undefined),
        note: (text: string) => void notes.push(text),
      } as unknown as DemoActionContext)
  return { controls, dispatched, notes, run }
}

describe("demo approvals", () => {
  it("asks for the selected terminal from another one, and queues a second", () => {
    const { controls, run } = setup()
    run("Ask to close selected")
    run("Ask to close selected")
    expect(controls.approvals.pending.getSnapshot()).toEqual([
      { requestId: "approval-1", from: "b", terminalId: "a", action: { type: "close" } },
      { requestId: "approval-2", from: "b", terminalId: "a", action: { type: "close" } },
    ])
  })

  it("closes the terminal on a confirmation, and leaves it on a refusal", () => {
    const { controls, dispatched, run } = setup()
    run("Ask to close selected")
    controls.approvals.answer("approval-1", false)
    expect(dispatched).toEqual([])
    run("Ask to close selected")
    controls.approvals.answer("approval-2", true)
    expect(dispatched).toEqual([
      {
        type: "terminal/close",
        target: { projectId: "p", workspaceSessionId: "s" },
        terminalId: "a",
      },
    ])
    expect(controls.approvals.pending.getSnapshot()).toEqual([])
  })

  it("makes the asker the lead on a confirmed lead ask, and leaves it on a refusal", () => {
    const { controls, dispatched, run } = setup()
    run("Ask to lead selected")
    expect(controls.approvals.pending.getSnapshot()).toMatchObject([
      { requestId: "approval-1", from: "b", terminalId: "a", action: { type: "lead" } },
    ])
    controls.approvals.answer("approval-1", false)
    expect(dispatched).toEqual([])
    run("Ask to lead selected")
    controls.approvals.answer("approval-2", true)
    expect(dispatched).toEqual([
      {
        type: "terminal/update",
        target: { projectId: "p", workspaceSessionId: "s" },
        terminalId: "a",
        ledBy: "bee",
      },
    ])
  })

  it("ends a lead when the person releases the terminal", () => {
    const { controls, dispatched } = setup()
    controls.release(key("a"))
    expect(dispatched).toEqual([
      {
        type: "terminal/update",
        target: { projectId: "p", workspaceSessionId: "s" },
        terminalId: "a",
        ledBy: null,
      },
    ])
  })

  it("takes the asks back", () => {
    const { controls, run } = setup()
    run("Ask to close selected")
    run("Withdraw approvals")
    expect(controls.approvals.pending.getSnapshot()).toEqual([])
  })

  it("says what it needs when no terminal is selected", () => {
    const { notes, run } = setup()
    run("Ask to close selected", false)
    expect(notes).toEqual(["Select a terminal first."])
  })
})
