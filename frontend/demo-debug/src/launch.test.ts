import type { LaunchCues } from "@novadeck/demo/launch"
import { vi } from "vitest"

import { launchGroups } from "./launch"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

const fire = () => vi.fn<() => void>()

const cues = (): { [Name in keyof LaunchCues]: ReturnType<typeof fire> } => ({
  states: fire(),
  asks: fire(),
  permission: fire(),
  plan: fire(),
  question: fire(),
  fail: fire(),
  finishOne: fire(),
  teammates: fire(),
  teammateAsks: fire(),
  teammateDone: fire(),
  show: fire(),
  showChanges: fire(),
  showVariants: fire(),
  askReview: fire(),
  showPlan: fire(),
  finishAll: fire(),
})

describe("the debug panel's Launch group", () => {
  it("is absent from every demo but the launch one", () => {
    expect(launchGroups(undefined)).toEqual([])
  })

  it("has one action for each beat's cue, numbered by the beat, each firing its cue", () => {
    const fired = cues()
    const [group] = launchGroups(fired as unknown as LaunchCues)
    expect(group).toMatchObject({ section: "Agents", title: "Launch" })
    const order = [
      ["3 ·", "states"],
      ["3a ·", "permission"],
      ["3b ·", "fail"],
      ["3c ·", "finishOne"],
      ["4 ·", "asks"],
      ["4a ·", "permission"],
      ["4b ·", "plan"],
      ["4c ·", "question"],
      ["5a ·", "teammates"],
      ["5b ·", "teammateAsks"],
      ["5c ·", "teammateDone"],
      ["6a ·", "show"],
      ["6b ·", "showChanges"],
      ["6c ·", "showVariants"],
      ["7 ·", "finishAll"],
      ["8a ·", "askReview"],
      ["8b ·", "showPlan"],
    ] as const
    expect(group!.actions).toHaveLength(order.length)
    const context = {} as DemoActionContext
    group!.actions.forEach((action, index) => {
      expect(action.label.startsWith(order[index]![0])).toBe(true)
      expect(action.hint).not.toBe("")
      void action.run(context)
      expect(fired[order[index]![1]]).toHaveBeenCalled()
    })
    expect(Object.values(fired).every((cue) => cue.mock.calls.length > 0)).toBe(true)
  })
})
