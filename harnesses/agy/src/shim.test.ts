import { describe, expect, it } from "vitest"

import { cmdShim } from "./shim.js"

describe("the Windows shim", () => {
  it("looks for the real agy on PATH only, never in the current folder where cmd looks first", () => {
    expect(cmdShim).toContain("('where $PATH:agy 2^>nul')")
    expect(cmdShim).not.toMatch(/where agy/)
  })
})
