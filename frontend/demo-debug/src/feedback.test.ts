import { createDemoFeedback } from "@novadeck/demo/feedback"
import { createDemoInbox } from "@novadeck/demo/inbox"
import { demoTerminalId } from "@novadeck/demo/samples"
import { demoTurns } from "@novadeck/demo/turns"
import { vi } from "vitest"

import type { BootRehearsal } from "./boot-rehearsal"
import { feedbackGroups } from "./feedback"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"
import type { DemoLaunch } from "./with-debug"

const rehearse = vi.fn<(rehearsal: BootRehearsal) => void>()
const launch = { rehearsals: { rehearse } } as unknown as DemoLaunch

const context = (over: Partial<DemoActionContext> = {}): DemoActionContext => ({
  target: "selected",
  selected: () => undefined,
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
  ...over,
})

const feedback = () => createDemoFeedback(demoTurns(), createDemoInbox(1, []), () => undefined)

describe("the debug panel's Feedback group", () => {
  it("is absent where the backend has no feedback", () => {
    expect(feedbackGroups(launch, undefined)).toEqual([])
  })

  it("sits in the App section, every action hinted", () => {
    const [group] = feedbackGroups(launch, feedback())
    expect(group?.section).toBe("App")
    expect(group?.actions.map((action) => action.label)).toEqual([
      "Next send fails",
      "Next ask fails",
      "Show the button's word again",
      "A feedback draft from the selected agent",
    ])
    expect(group?.actions.every((action) => action.hint.length > 0)).toBe(true)
  })

  it("makes the next send fail", async () => {
    vi.useFakeTimers()
    try {
      const demo = feedback()
      const [group] = feedbackGroups(launch, demo)
      void group!.actions[0]!.run(context())
      const caught = demo.send({ kind: null, text: "a" }).catch((error: Error) => error.message)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await caught).toMatch(/network/)
    } finally {
      vi.useRealTimers()
    }
  })

  it("makes the next ask fail", async () => {
    const demo = feedback()
    const [group] = feedbackGroups(launch, demo)
    void group!.actions.find((each) => each.label === "Next ask fails")!.run(context())
    const key = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }
    await expect(demo.ask(key, "")).rejects.toThrow(/No agent/)
  })

  it("clears the button's mark and boots again", () => {
    window.localStorage.setItem("novadeck.feedback-opened", "1")
    const [group] = feedbackGroups(launch, feedback())
    const again = group!.actions.find((each) => each.label === "Show the button's word again")!
    expect(again.reboots).toBe(true)
    void again.run(context())
    expect(window.localStorage.getItem("novadeck.feedback-opened")).toBeNull()
    expect(rehearse).toHaveBeenCalledWith({ reboot: true })
  })

  it("asks the selected terminal, and says so where none is or no agent runs there", async () => {
    const notes: string[] = []
    const [group] = feedbackGroups(launch, feedback())
    const ask = group!.actions.find((each) => each.label.startsWith("A feedback draft"))!
    await ask.run(context({ note: (text) => notes.push(text) }))
    const key = {
      projectId: "storefront",
      workspaceSessionId: "initial",
      terminalId: demoTerminalId({ projectId: "storefront", workspaceSessionId: "initial" }, 1),
    }
    await ask.run(context({ selected: () => key, note: (text) => notes.push(text) }))
    await Promise.resolve()
    expect(notes).toEqual(["Select a terminal first.", "Select a terminal running an agent first."])
  })
})
