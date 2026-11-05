import { describe, expect, it } from "vitest"

import { cmdShim } from "./shim.js"

describe("the Windows shim", () => {
  it("looks for the real codex on PATH only, never in the current folder where cmd looks first", () => {
    expect(cmdShim).toContain("('where $PATH:codex 2^>nul')")
    expect(cmdShim).not.toMatch(/where codex/)
  })

  it("skips another Novadeck's shim, which would call this one back", () => {
    expect(cmdShim).toContain('/c:"rem novadeck shim for codex"')
  })
})
