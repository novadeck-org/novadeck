import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { idlesOn, replaySlices, type SliceFixture } from "@novadeck/harness-core/testing/slices"
import { describe, expect, it } from "vitest"

import { box, slice } from "./box.js"

// Probed 2026-11-22, 1.19.6 (fixtures/live-slice.probe.json).
const { runs } = loadProbe<SliceFixture>(import.meta.dirname, "live-slice.probe.json")

const replayed = (run: string) => replaySlices(runs[run]!, box, slice)
const at = (run: string, label: string) => replayed(run).find((step) => step.label === label)!

describe("opencode's live slice", () => {
  it("shows the / menu over the box, down to the row above its bare top row", () => {
    const { bounds, rows } = at("home", "/")
    expect(bounds?.reason).toBe("menu")
    expect(rows[0]).toContain("/")
    expect(rows.at(-1)).toContain("/models")
  })

  it("shows the / menu of a session, and over a running turn", () => {
    expect(at("session", "/").bounds?.reason).toBe("menu")
    expect(at("session", "/").rows.join("\n")).toContain("/compact")
    expect(at("busy", "/").bounds?.reason).toBe("menu")
    expect(at("busy", "/").rows.join("\n")).toContain("/agents")
  })

  it("shows the @ menu, which Enter would pick from", () => {
    expect(at("home", "@").bounds?.reason).toBe("menu")
    expect(at("home", "@").rows.join("\n")).toContain("@general")
    expect(at("session", "@").rows.join("\n")).toContain("@explore")
  })

  it("shows its dialogs as views, over the box that reads empty under them", () => {
    const { bounds, rows } = at("home", "models")
    expect(bounds?.reason).toBe("view")
    expect(rows.join("\n")).toContain("Select model")
  })

  it("shows none at rest, and none once the menu closed", () => {
    expect(at("home", "start").bounds).toBeUndefined()
    expect(at("home", "start again").bounds).toBeUndefined()
    expect(at("session", "idle again").bounds).toBeUndefined()
    expect(at("busy", "busy").bounds).toBeUndefined()
  })

  it("reads the menu on 60 columns too", () => {
    expect(at("narrow", "/").bounds?.reason).toBe("menu")
    expect(at("narrow", "/").rows.join("\n")).toContain("/agents")
  })

  it("marks no menu or dialog a secret", () => {
    for (const run of Object.keys(runs))
      expect(replayed(run).some(({ secret }) => secret)).toBe(false)
  })
})

describe("opencode's secret prompt", () => {
  const { screens } = loadProbe<{
    screens: { [name: string]: import("@novadeck/emulator/headless").ScreenText }
  }>(import.meta.dirname, "dialogs.probe.json")

  it("marks /connect's API key prompt, where what is typed shows", () => {
    expect(slice.secret(screens.connectKey!.rows)).toBe(true)
    expect(slice.secret(screens.connectTyped!.rows)).toBe(true)
  })

  it("marks none of its other dialogs", () => {
    for (const name of ["models", "help", "palette", "permBash", "qOne"])
      expect(slice.secret(screens[name]!.rows), name).toBe(false)
  })
})

describe("opencode's idle", () => {
  const { screens } = loadProbe<{
    screens: { [name: string]: import("@novadeck/emulator/headless").ScreenText }
  }>(import.meta.dirname, "input-box.probe.json")

  it("idles at its home screen and in an empty session, nothing else drawn", () => {
    for (const name of ["homeEmpty", "homeEmpty60", "sessEmpty", "sessEmpty60", "busy"])
      expect(idlesOn(screens[name]!, box, slice), name).toBe(true)
  })

  it("does not idle with a draft, or with a menu open", () => {
    for (const name of ["homeDraft", "sessDraft", "homePaste3", "homeSlash", "sessAt"])
      expect(idlesOn(screens[name]!, box, slice), name).toBe(false)
  })

  it("does not idle under one of its dialogs", () => {
    for (const name of ["models", "help", "palette"])
      expect(idlesOn(screens[name]!, box, slice), name).toBe(false)
  })
})
