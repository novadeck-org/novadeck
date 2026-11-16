import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { idlesOn, replaySlices, type SliceFixture } from "@novadeck/harness-core/testing/slices"
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

describe("Codex's idle", () => {
  const startup = loadProbe<{ [screen: string]: ScreenText }>(
    import.meta.dirname,
    "startup.probe.json",
  )

  it("idles at its prompt on a new session: an empty box, nothing else drawn", () => {
    expect(idlesOn(startup.prompt!, box, slice)).toBe(true)
  })

  it("does not idle on its start-up screens before it", () => {
    for (const screen of ["trust", "hooks", "signIn", "resume", "update"])
      expect(idlesOn(startup[screen]!, box, slice), screen).toBe(false)
  })

  it("does not idle on its question panel, which the box reader takes for a box with text", () => {
    const { scenarios } = loadProbe<{
      scenarios: { [name: string]: { screens: { [size: string]: ScreenText } } }
    }>(import.meta.dirname, "ask.probe.json")
    for (const size of ["wide", "narrow"]) {
      const screen = scenarios["rui-default-on"]!.screens[size]!
      expect(box.read(screen)?.text, size).not.toBe("")
      expect(idlesOn(screen, box, slice), size).toBe(false)
    }
  })

  it("does not idle with a draft in its box", () => {
    const rows = startup.prompt!.rows.map((row, line) => (line === 36 ? "› a draft" : row))
    const drafted = { ...startup.prompt!, rows, bright: rows }
    expect(box.read(drafted)?.text).toBe("a draft")
    expect(idlesOn(drafted, box, slice)).toBe(false)
  })
})
