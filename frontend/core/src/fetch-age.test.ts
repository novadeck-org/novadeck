import { describe, expect, it } from "vitest"

import { failingFor, staleFetchMs } from "./fetch-age"

const minute = 60_000

describe("how long origin has failed to fetch", () => {
  it("says it to the minute, hour or day, rounded down, and at least a minute", () => {
    expect(failingFor(0, 30_000)).toBe("1 min")
    expect(failingFor(0, 12 * minute + 59_000)).toBe("12 min")
    expect(failingFor(0, 3 * 60 * minute + 59 * minute)).toBe("3 h")
    expect(failingFor(0, 49 * 60 * minute)).toBe("2 d")
    expect(failingFor(10 * minute, 0)).toBe("1 min")
  })

  it("waits an hour before saying so", () => {
    expect(staleFetchMs).toBe(60 * minute)
  })
})
