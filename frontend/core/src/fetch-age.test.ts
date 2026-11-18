import { describe, expect, it } from "vitest"

import { fetchAge, staleFetchMs } from "./fetch-age"

const minute = 60_000

describe("how long ago origin was fetched", () => {
  it("says it to the minute, hour or day, rounded down", () => {
    expect(fetchAge(0, 30_000)).toBe("just now")
    expect(fetchAge(0, 12 * minute + 59_000)).toBe("12 min ago")
    expect(fetchAge(0, 3 * 60 * minute + 59 * minute)).toBe("3 h ago")
    expect(fetchAge(0, 49 * 60 * minute)).toBe("2 d ago")
    expect(fetchAge(10 * minute, 0)).toBe("just now")
  })

  it("calls an hour old", () => {
    expect(staleFetchMs).toBe(60 * minute)
  })
})
