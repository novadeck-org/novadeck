import { describe, expect, it } from "vitest"

import { explain, refuse } from "./dialogs.js"

describe("a refusal", () => {
  it("returns undefined and notes nothing where no one explains", () => {
    expect(refuse("question.footer.1")).toBeUndefined()
    expect(explain(() => 1).refusals).toEqual([])
  })

  it("is noted in order, a repeat of the code before it once, by the run that explains", () => {
    const { result, refusals } = explain(() => {
      refuse("a.b.1")
      refuse("a.b.1")
      refuse("a.c.2")
      return "read"
    })
    expect(result).toBe("read")
    expect(refusals).toEqual(["a.b.1", "a.c.2"])
  })

  it("keeps the codes of a nested run to it, and hands back to the run around it", () => {
    const outer = explain(() => {
      refuse("outer.step.1")
      const inner = explain(() => refuse("inner.step.1"))
      refuse("outer.step.2")
      return inner.refusals
    })
    expect(outer.result).toEqual(["inner.step.1"])
    expect(outer.refusals).toEqual(["outer.step.1", "outer.step.2"])
  })

  it("stops tracing after a run that throws", () => {
    expect(() =>
      explain(() => {
        throw new Error("no")
      }),
    ).toThrow("no")
    expect(explain(() => refuse("after.throw.1")).refusals).toEqual(["after.throw.1"])
  })

  it("keeps no more codes than a log line may carry", () => {
    const { refusals } = explain(() => {
      for (let n = 0; n < 100; n += 1) refuse(`a.b.${n}`)
    })
    expect(refusals).toHaveLength(32)
  })
})
