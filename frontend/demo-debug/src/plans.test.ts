import { itemIdOf, type CompanionKey, type ItemContent } from "@novadeck/core/items"
import { studioAgent } from "@novadeck/demo/showcase/agents"
import { createShowcase } from "@novadeck/demo/showcase/simulation"

import { planGroups } from "./plans"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

const key: CompanionKey = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }

const run = (
  label: string,
  selected: CompanionKey | undefined,
  companions: ReturnType<typeof createShowcase>,
) => {
  const notes: string[] = []
  const context = {
    selected: () => selected,
    note: (text: string) => notes.push(text),
  } as unknown as DemoActionContext
  void planGroups(companions)[0]!
    .actions.find((action) => action.label === label)!
    .run(context)
  return notes
}

const showcase = () =>
  createShowcase({ agents: [{ key, handle: "moth", sample: studioAgent }] }, (_delay, go) => go())

describe("the debug panel's Plan group", () => {
  it("is absent where the showcase has no agent with a plan", () => {
    expect(planGroups(createShowcase({ agents: [] }))).toEqual([])
  })

  it("is absent where the demo has no showcase", () => {
    expect(planGroups(undefined)).toEqual([])
  })

  it("hints what each action shows", () => {
    const [group] = planGroups(showcase())
    expect(group!.section).toBe("Agents")
    expect(group!.actions.every((action) => action.hint.length > 0)).toBe(true)
  })

  it("puts the selected agent's plan in a fault, and back", () => {
    const companions = showcase()
    let content: ItemContent | undefined
    companions.follow(key, itemIdOf(studioAgent.plan.id), { reveal: false }, (next) => {
      content = next
    })
    run("Plan file deleted", key, companions)
    expect(content).toMatchObject({ state: "unavailable", reason: "gone" })
    run("Plan back to normal", key, companions)
    expect(content).toMatchObject({ state: "ready" })
  })

  it("asks for a terminal with a plan first", () => {
    expect(run("Plan file deleted", undefined, showcase())).toEqual([
      "Select a terminal whose agent wrote a plan first.",
    ])
  })
})
