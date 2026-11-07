import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { replaySlices, type SliceFixture } from "@novadeck/harness-core/testing/slices"
import { describe, expect, it } from "vitest"

import { box, slice } from "./box.js"

const { runs } = loadProbe<SliceFixture>(import.meta.dirname, "live-slice.probe.json")

const replayed = (run: string) => replaySlices(runs[run]!, box, slice)
const at = (run: string, label: string, nth = 0) =>
  replayed(run).filter((step) => step.label === label)[nth]!

describe("Codex's live slice", () => {
  it("shows the / menu above the box, nothing of the transcript", () => {
    const step = at("menus", "/")
    expect(step.bounds?.reason).toBe("menu")
    expect(step.rows).toHaveLength(8)
    expect(step.rows[0]).toContain("/model")
    expect(step.rows.at(-1)).toContain("/approve")
  })

  it("filters and closes with the box", () => {
    expect(at("menus", "m").rows.join("\n")).toContain("/model")
    expect(at("menus", "<kill>").bounds).toBeUndefined()
  })

  it("shows the @ panel whole, its title to its hint", () => {
    const { bounds, rows } = at("menus", "@")
    expect(bounds?.reason).toBe("menu")
    expect(rows[0]).toContain("Mentions")
    expect(rows.at(-1)).toContain("esc close")
  })

  it("shows the $ menu, a key of its own", () => {
    const { bounds, rows } = at("menus", "$")
    expect(bounds?.reason).toBe("menu")
    expect(rows.join("\n")).toContain("[Skill]")
    expect(rows.at(-1)).toContain("esc close")
  })

  it("shows a view from its first row to the screen's end", () => {
    const { bounds, rows } = at("menus", "<enter>")
    expect(bounds?.reason).toBe("view")
    expect(rows[0]).toContain("Select Model and Effort")
    expect(rows.at(-1)).toContain("esc back")
  })

  it("shows none for a command that only prints", () => {
    const steps = replayed("menus")
    const printed = steps[steps.findIndex(({ label }) => label === "/status") + 1]!
    expect(printed.bounds).toBeUndefined()
  })

  it("shows its pager as a view", () => {
    const steps = replayed("menus")
    const pager = steps.at(-1)!
    expect(pager.bounds?.reason).toBe("view")
    expect(pager.rows.at(-1)).toContain("q close")
  })

  it("carries only its working line beside the menu mid-turn", () => {
    const { bounds, rows } = at("mid-turn", "/")
    expect(bounds?.reason).toBe("menu")
    expect(rows[0]).toContain("Working")
    expect(rows.at(-1)).toContain("/approve")
  })

  it("reads a narrower screen and the latest version as the pinned one", () => {
    expect(at("narrow", "/").rows[0]).toContain("/model")
    expect(at("narrow", "/").rows.at(-1)).toContain("/approve")
    expect(at("latest", "/").rows).toHaveLength(8)
    expect(at("latest", "<enter>").bounds?.reason).toBe("view")
  })

  it("marks no row a secret: it asks for none in a session", () => {
    expect(replayed("menus").some(({ secret }) => secret)).toBe(false)
  })
})
