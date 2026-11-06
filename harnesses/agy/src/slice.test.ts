import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { replaySlices, type SliceFixture } from "@novadeck/harness-core/testing/slices"
import { describe, expect, it } from "vitest"

import { box, slice } from "./box.js"

const { runs } = loadProbe<SliceFixture>(import.meta.dirname, "live-slice.probe.json")

const replayed = (run: string) => replaySlices(runs[run]!, box, slice)
const at = (run: string, label: string, nth = 0) =>
  replayed(run).filter((step) => step.label === label)[nth]!

describe("Antigravity's live slice", () => {
  it("shows the / menu under the box, its closing rule left out", () => {
    const { bounds, rows } = at("menus", "/")
    expect(bounds?.reason).toBe("menu")
    expect(rows[0]).toContain("/add-dir")
    expect(rows.join("\n")).toContain("more")
    expect(rows.at(-1)).toContain("esc to cancel")
  })

  it("moves with the mark and closes with the box", () => {
    expect(at("menus", "<down>").rows[1]).toContain("> /agents")
    expect(at("menus", "<kill>").bounds).toBeUndefined()
  })

  it("shows the @ picker", () => {
    expect(at("menus", "@").bounds?.reason).toBe("menu")
    expect(at("menus", "s").rows.join("\n")).toContain("src/")
  })

  it("shows a view under the box that stays, empty", () => {
    const { bounds, rows } = at("menus", "<enter>", 1)
    expect(bounds?.reason).toBe("view")
    expect(rows[0]).toContain("Permission Config Editor")
  })

  it("shows a view too tall for the rows left, on the alternate screen", () => {
    const { bounds, rows } = at("views", "<enter>")
    expect(bounds?.reason).toBe("view")
    expect(rows.join("\n")).toContain("Antigravity CLI understands")
  })

  it("shows none for its one footer row at rest, or mid-turn", () => {
    const steps = replayed("menus")
    expect(steps[0]!.bounds).toBeUndefined()
    expect(steps.find(({ label }) => label === "mid-turn")?.bounds).toBeUndefined()
  })

  it("reads the latest version as the pinned one", () => {
    expect(at("latest", "/").rows[0]).toContain("/add-dir")
  })

  it("marks no row a secret: none was reached", () => {
    expect(replayed("menus").some(({ secret }) => secret)).toBe(false)
  })
})
