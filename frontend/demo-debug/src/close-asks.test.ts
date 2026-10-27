import type { BackendAction } from "@novadeck/core/port"
import type { Workspace } from "@novadeck/core/types"

import { closeAskGroups, createDemoCloseAsks } from "./close-asks"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

const key = (terminalId: string) => ({ projectId: "p", workspaceSessionId: "s", terminalId })
const terminal = (id: string) => ({ id, state: "running", process: "claude" })
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
  const controls = createDemoCloseAsks(() => (actions) => dispatched.push(...actions))
  const [group] = closeAskGroups(controls, () => workspace)
  const run = (label: string, selected = true) =>
    void group!.actions
      .find((action) => action.label === label)!
      .run({
        selected: () => (selected ? key("a") : undefined),
        note: (text: string) => void notes.push(text),
      } as unknown as DemoActionContext)
  return { controls, dispatched, notes, run }
}

describe("demo close asks", () => {
  it("asks for the selected terminal from another one, and queues a second", () => {
    const { controls, run } = setup()
    run("Ask to close selected")
    run("Ask to close selected")
    expect(controls.closeAsks.pending.getSnapshot()).toEqual([
      { requestId: "close-ask-1", from: "b", terminalId: "a" },
      { requestId: "close-ask-2", from: "b", terminalId: "a" },
    ])
  })

  it("closes the terminal on a confirmation, and leaves it on a refusal", () => {
    const { controls, dispatched, run } = setup()
    run("Ask to close selected")
    controls.closeAsks.answer("close-ask-1", false)
    expect(dispatched).toEqual([])
    run("Ask to close selected")
    controls.closeAsks.answer("close-ask-2", true)
    expect(dispatched).toEqual([
      {
        type: "terminal/close",
        target: { projectId: "p", workspaceSessionId: "s" },
        terminalId: "a",
      },
    ])
    expect(controls.closeAsks.pending.getSnapshot()).toEqual([])
  })

  it("takes the asks back", () => {
    const { controls, run } = setup()
    run("Ask to close selected")
    run("Withdraw asks")
    expect(controls.closeAsks.pending.getSnapshot()).toEqual([])
  })

  it("says what it needs when no terminal is selected", () => {
    const { notes, run } = setup()
    run("Ask to close selected", false)
    expect(notes).toEqual(["Select a terminal first."])
  })
})
