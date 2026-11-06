import { describe, expect, it } from "vitest"

import { claude } from "./index.js"
import { cmdShim, many, posixShim, valued } from "./shim.js"

describe("the Windows shim", () => {
  it("looks for the real claude on PATH only, never in the current folder where cmd looks first", () => {
    expect(cmdShim).toContain("('where $PATH:claude 2^>nul')")
    expect(cmdShim).not.toMatch(/where claude/)
  })
})

describe("the Windows shim's labels", () => {
  it("are there for every goto and call, which only cmd would otherwise find out", () => {
    const labels = new Set([...cmdShim.matchAll(/^:(\w+)$/gm)].map(([, label]) => label))
    const targets = [...cmdShim.matchAll(/\b(?:goto |call :)(\w+)/g)].map(([, label]) => label)
    expect(targets).toContain("list")
    expect(targets.filter((target) => !labels.has(target))).toEqual([])
  })
})

describe("the shims' reading of a command line", () => {
  it("skips each option's value as the runner's reading does", () => {
    expect(claude.nonSession.takesValue).toBe(valued)
    expect(posixShim).toContain(`    ${valued.join(" | ")}) novadeck_value=1 ;;`)
    expect(cmdShim).toContain(`for %%v in (${valued.join(" ")}) do`)
  })

  it("skips a list's words as the runner's reading does", () => {
    expect(claude.nonSession.takesMany).toBe(many)
    expect(valued).toEqual(expect.arrayContaining(many))
    expect(posixShim).toContain(`    ${many.join(" | ")}) novadeck_value=1 novadeck_list=1 ;;`)
    expect(cmdShim).toContain(`for %%v in (${many.join(" ")}) do`)
  })
})
