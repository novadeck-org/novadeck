import { createDemoHistory } from "@novadeck/demo/history"

import { historyGroups } from "./history"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

const context = (selected: DemoActionContext["selected"]): DemoActionContext => ({
  target: "selected",
  harness: "claude",
  selected,
  select: () => {},
  addTerminal: () => {
    throw new Error("unused")
  },
  addInBackground: () => {
    throw new Error("unused")
  },
  startFresh: () => undefined,
  dispatch: undefined,
  workspace: () => undefined,
  note: () => undefined,
  crash: () => undefined,
})

describe("the debug panel's History group", () => {
  it("offers nothing where the backend's History isn't the demo's", () => {
    expect(historyGroups(undefined)).toEqual([])
    expect(
      historyGroups({ state: createDemoHistory(0).history.state, list: async () => [] }),
    ).toEqual([])
  })

  it("makes the selected terminal's agent unrestorable, and restorable again", () => {
    const { history } = createDemoHistory(0)
    const [group] = historyGroups(history)
    const key = { projectId: "storefront", workspaceSessionId: "initial", terminalId: "01" }
    const run = (label: string) =>
      void group!.actions.find((action) => action.label === label)!.run(context(() => key))
    run("Selected agent can't be restored")
    expect(history.isRestorable("01")).toBe(false)
    expect(history.isRestorable("02")).toBe(true)
    run("Selected agent can be restored")
    expect(history.isRestorable("01")).toBe(true)
  })
})
