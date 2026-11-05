import { describe, expect, it } from "vitest"

import { claude } from "./index.js"
import { cmdShim, posixShim, valued } from "./shim.js"

describe("the Windows shim", () => {
  it("looks for the real claude on PATH only, never in the current folder where cmd looks first", () => {
    expect(cmdShim).toContain("('where $PATH:claude 2^>nul')")
    expect(cmdShim).not.toMatch(/where claude/)
  })
})

describe("the shims' reading of a command line", () => {
  it("skips each option's value as the runner's reading does", () => {
    expect(claude.nonSession.takesValue).toBe(valued)
    expect(posixShim).toContain(`    ${valued.join(" | ")}) novadeck_value=1 ;;`)
    expect(cmdShim).toContain(`for %%v in (${valued.join(" ")}) do`)
  })
})
