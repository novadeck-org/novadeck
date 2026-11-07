import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { replaySlices, type SliceFixture } from "@novadeck/harness-core/testing/slices"
import { describe, expect, it } from "vitest"

import { box, slice } from "./box.js"

const { runs } = loadProbe<SliceFixture>(import.meta.dirname, "live-slice.probe.json")

const replayed = (run: string) => replaySlices(runs[run]!, box, slice)
const at = (run: string, label: string, nth = 0) =>
  replayed(run).filter((step) => step.label === label)[nth]!

describe("Claude Code's live slice", () => {
  it("shows the fullscreen renderer's menu above the box, nothing of the transcript", () => {
    const step = at("fullscreen", "/")
    expect(step.bounds?.reason).toBe("menu")
    expect(step.rows).toHaveLength(5)
    expect(step.rows[0]).toContain("/add-dir")
    expect(step.rows.at(-1)).toContain("/branch")
  })

  it("moves with the mark and closes with the box", () => {
    expect(at("fullscreen", "<down>").rows[1]).toContain("❯ /auto-mode-setup")
    expect(at("fullscreen", "<kill>").bounds).toBeUndefined()
  })

  it("shows the @ picker", () => {
    expect(at("fullscreen", "@").bounds?.reason).toBe("menu")
    expect(at("fullscreen", "s").rows.join("\n")).toContain("src/")
  })

  it("shows a view from its edge to the screen's end, the transcript moved up", () => {
    const step = at("fullscreen", "<enter>")
    expect(step.bounds?.reason).toBe("view")
    expect(step.rows[0]).toMatch(/^▔+$/)
    expect(step.rows[1]).toContain("Select model")
    expect(step.rows.at(-1)).toContain("Esc to cancel")
  })

  it("takes a view of the whole screen whole", () => {
    const step = at("whole-screen", "<enter>")
    expect(step.bounds?.reason).toBe("view")
    expect(step.rows.join("\n")).toContain("Auto-update channel")
  })

  it("shows the classic renderer's list under the box, its rule left out", () => {
    const step = at("classic", "/")
    expect(step.bounds?.reason).toBe("menu")
    expect(step.rows[0]).toContain("/add-dir")
    expect(step.rows.join("\n")).not.toContain("Long line")
  })

  it("shows the classic renderer's view in the box's place", () => {
    const step = at("classic", "<enter>")
    expect(step.bounds?.reason).toBe("view")
    expect(step.rows.join("\n")).toContain("Select model")
    expect(step.rows.join("\n")).not.toContain("Long line")
  })

  it("marks its code prompt as a secret, and the menus before it not", () => {
    expect(at("login", "#code").secret).toBe(true)
    expect(at("login", "#typed").secret).toBe(true)
    expect(at("login", "/login").secret).toBe(false)
  })

  it("leaves a narrower screen's wrapped rows in", () => {
    const step = at("narrow", "/")
    expect(step.rows).toHaveLength(5)
    expect(step.rows[2]).toContain("optional rule tweaks")
  })

  it("reads the latest version as the pinned one", () => {
    expect(at("latest", "/").rows).toHaveLength(5)
    expect(at("latest", "<enter>").bounds?.reason).toBe("view")
  })
})
