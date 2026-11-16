import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { idlesOn, replaySlices, type SliceFixture } from "@novadeck/harness-core/testing/slices"
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

describe("Claude Code's idle", () => {
  const startup = loadProbe<{ [screen: string]: ScreenText }>(
    import.meta.dirname,
    "startup.probe.json",
  )

  it("idles at its prompt on a new session: an empty box, nothing else drawn", () => {
    expect(idlesOn(startup.prompt!, box, slice)).toBe(true)
  })

  it("does not idle on its start-up screens before it", () => {
    for (const screen of ["trust", "onboarding", "resume", "signIn"])
      expect(idlesOn(startup[screen]!, box, slice), screen).toBe(false)
  })

  it("does not idle on a dialog, whatever frame it is drawn in", () => {
    const { scenarios } = loadProbe<{
      scenarios: { [name: string]: { screens?: { [size: string]: ScreenText } } }
    }>(import.meta.dirname, "ask.probe.json")
    let seen = 0
    for (const { screens = {} } of Object.values(scenarios))
      for (const [size, screen] of Object.entries(screens)) {
        seen += 1
        expect(idlesOn(screen, box, slice), size).toBe(false)
      }
    expect(seen).toBeGreaterThan(10)
  })

  it("does not idle with a draft in its box", () => {
    const rows = startup.prompt!.rows.map((row, line) => (line === 36 ? "❯ a draft" : row))
    const drafted = { ...startup.prompt!, rows, bright: rows }
    expect(box.read(drafted)?.text).toBe("a draft")
    expect(idlesOn(drafted, box, slice)).toBe(false)
  })
})
