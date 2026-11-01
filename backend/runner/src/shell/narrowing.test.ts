import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { Narrowing, startsAgy, startsAgyInPlan } from "./narrowing.js"

describe("a command line that starts Antigravity", () => {
  it.each(["agy", "agy --model x", "  agy -c", "agy --mode auto", "agy --mode=accept-edits"])(
    "may take a launch grant: %s",
    (command) => {
      expect(startsAgy(command)).toBe(true)
    },
  )

  it.each(["agy --mode plan", "agy --mode=plan", 'agy --mode "plan"', "agy -c --mode='plan'"])(
    "takes none in plan mode: %s",
    (command) => {
      expect(startsAgy(command)).toBe(false)
    },
  )

  it("is not another program", () => {
    expect(startsAgy("claude --mode auto")).toBe(false)
    expect(startsAgyInPlan("claude --mode plan")).toBe(false)
  })

  it("is in plan mode exactly where it takes no launch grant for that reason", () => {
    expect(startsAgyInPlan("agy --mode plan")).toBe(true)
    expect(startsAgyInPlan("agy -c --mode=plan")).toBe(true)
    expect(startsAgyInPlan("agy --mode auto")).toBe(false)
    expect(startsAgyInPlan("agy")).toBe(false)
  })
})

describe("a terminal whose Antigravity starts in plan mode", () => {
  it("gets no launch settings and no launch set, and is remembered until the next launch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "novadeck-narrowing-"))
    try {
      const narrowing = new Narrowing({
        grants: { launchPrograms: () => ["uberepo"] },
        verified: () => Promise.resolve(true),
      })
      const verified = await narrowing.verify(join(directory, "narrow"))
      const settings = join(directory, "narrow", "t.json")
      // Started as `startsAgy` and `startsAgyInPlan` read the line: not a grant start, but a plan one.
      const line = "agy --mode plan"
      narrowing.launch("t", verified, startsAgy(line), startsAgyInPlan(line))
      expect(existsSync(settings)).toBe(false)
      expect(narrowing.launchSet("t")).toBeUndefined()
      expect(narrowing.startedInPlan("t")).toBe(true)
      // Started again without the mode: it takes the grant, and is no plan terminal.
      narrowing.launch("t", verified, startsAgy("agy"), startsAgyInPlan("agy"))
      expect(existsSync(settings)).toBe(true)
      expect(narrowing.launchSet("t")).toEqual(new Set(["uberepo"]))
      expect(narrowing.startedInPlan("t")).toBe(false)
      narrowing.launch("t", verified, false, true)
      narrowing.forget("t")
      expect(narrowing.startedInPlan("t")).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
