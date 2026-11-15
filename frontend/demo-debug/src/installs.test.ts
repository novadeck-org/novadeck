import { createDemoInstalls } from "@novadeck/demo/agents/installs"

import { installGroups } from "./installs"
import { describe, expect, it } from "./test"

describe("the agent installs group", () => {
  it("opens the welcome dialog with every agent not installed", () => {
    const installs = createDemoInstalls()
    const opened: string[] = []
    const [group] = installGroups(installs, { openWelcomeBare: () => opened.push("bare") })
    const action = group!.actions.find((each) => each.label === "Nothing installed")!
    void action.run({} as never)
    expect(opened).toEqual(["bare"])
    expect(group!.section).toBe("App")
  })

  it("gives each action a hint that says what appears", () => {
    const [group] = installGroups(createDemoInstalls(), { openWelcomeBare: () => {} })
    expect(group!.actions.map((action) => action.label)).toEqual([
      "Nothing installed",
      "Hold next install",
      "Finish held install",
      "Fail next install",
    ])
    for (const action of group!.actions) expect(action.hint.length).toBeGreaterThan(20)
  })
})
