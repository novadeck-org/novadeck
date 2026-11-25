import type { LaunchCues } from "@novadeck/demo/videos/launch"
import { launchFiles } from "@novadeck/demo/videos/launch-files"
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
  command: fire(),
  agyPlan: fire(),
  fail: fire(),
  finishOne: fire(),
  teammates: fire(),
  teammateAsks: fire(),
  teammateDone: fire(),
  show: fire(),
  showChanges: fire(),
  showVariants: fire(),
  showVideo: fire(),
  showPdf: fire(),
  showModel: fire(),
  showFolder: fire(),
  checksPass: fire(),
  writeFiles: fire(),
  askReview: fire(),
  showPlan: fire(),
  finishAll: fire(),
})

describe("the debug panel's Launch group", () => {
  it("is absent from every demo but the launch one", () => {
    expect(launchGroups(undefined, vi.fn())).toEqual([])
  })

  it("has one action for each beat's cue, numbered by the beat, each firing its cue", () => {
    const fired = cues()
    const [group] = launchGroups(fired as unknown as LaunchCues, vi.fn())
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
      ["6d ·", "showVideo"],
      ["6e ·", "showPdf"],
      ["6f ·", "showModel"],
      ["6g ·", "showFolder"],
      ["7 ·", "finishAll"],
      ["8a ·", "askReview"],
      ["8b ·", "showPlan"],
      ["8c ·", "command"],
      ["8d ·", "agyPlan"],
      ["9a ·", "checksPass"],
      ["9b ·", "writeFiles"],
    ] as const
    // (and, after the cues, the action that boots the demo with the Files panel)
    expect(group!.actions).toHaveLength(order.length + 1)
    expect(group!.actions.at(-1)).toMatchObject({ label: "Files panel on", reboots: true })
    const context = {} as DemoActionContext
    group!.actions.slice(0, order.length).forEach((action, index) => {
      expect(action.label.startsWith(order[index]![0])).toBe(true)
      expect(action.hint).not.toBe("")
      void action.run(context)
      expect(fired[order[index]![1]]).toHaveBeenCalled()
    })
    expect(Object.values(fired).every((cue) => cue.mock.calls.length > 0)).toBe(true)
  })

  it("boots the demo again, with the Files panel on, from its last action", () => {
    const reboot = vi.fn<() => void>()
    const [group] = launchGroups(cues() as unknown as LaunchCues, reboot)
    try {
      void group!.actions.at(-1)!.run({} as DemoActionContext)
      expect(launchFiles.on).toBe(true)
      expect(reboot).toHaveBeenCalledTimes(1)
    } finally {
      launchFiles.on = false
    }
  })
})
