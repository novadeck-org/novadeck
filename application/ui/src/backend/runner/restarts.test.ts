import { describe, expect, it } from "../../test"
import { restartingTooOften } from "./backend"

describe("runner crash loop", () => {
  it("allows three restarts within a minute", () => {
    expect(restartingTooOften([0, 10_000, 20_000], 30_000)).toBe(false)
  })

  it("stops starting shells on the fourth", () => {
    expect(restartingTooOften([0, 10_000, 20_000, 30_000], 40_000)).toBe(true)
  })

  it("forgets restarts older than a minute", () => {
    expect(restartingTooOften([0, 10_000, 20_000, 30_000], 70_000)).toBe(false)
  })
})
