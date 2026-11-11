import { describe, expect, it } from "vitest"

import { failFirst } from "../attempts.ts"

describe("a flaky test", () => {
  it("fails first, then passes", () => {
    failFirst(`${import.meta.dirname} flaky`)
    expect(true).toBe(true)
  })
})
