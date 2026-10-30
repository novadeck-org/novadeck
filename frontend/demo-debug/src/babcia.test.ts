import type { BabciaCues } from "@novadeck/demo/videos/babcia"
import { vi } from "vitest"

import { babciaGroups } from "./babcia"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

const fire = () => vi.fn<() => void>()

const cues = (): { [Name in keyof BabciaCues]: ReturnType<typeof fire> } => ({
  asks: fire(),
  permission: fire(),
  plan: fire(),
  question: fire(),
  manners: fire(),
  fail: fire(),
  helpers: fire(),
  helperAsks: fire(),
  show: fire(),
  finishAll: fire(),
})

describe("the debug panel's Babcia group", () => {
  it("is absent from every demo but Babcia's", () => {
    expect(babciaGroups(undefined)).toEqual([])
  })

  it("has one action for each of the video's beats, each firing its cue", () => {
    const fired = cues()
    const [group] = babciaGroups(fired as unknown as BabciaCues)
    expect(group).toMatchObject({ section: "Agents", title: "Babcia" })
    const context = {} as DemoActionContext
    const order = [
      "asks",
      "permission",
      "plan",
      "question",
      "manners",
      "fail",
      "helpers",
      "helperAsks",
      "show",
      "finishAll",
    ] as const
    expect(group!.actions).toHaveLength(order.length)
    group!.actions.forEach((action, index) => {
      expect(action.hint).not.toBe("")
      void action.run(context)
      expect(fired[order[index]!]).toHaveBeenCalledOnce()
    })
  })
})
