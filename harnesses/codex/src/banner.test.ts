import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { bannerVersion } from "./banner.js"

const { version, screens } = loadProbe(import.meta.dirname, "banner.probe.json") as {
  version: string
  screens: { [name: string]: ScreenText }
}

describe("the version in Codex's banner, as captured", () => {
  it("names the release running at a fresh start and as a resume first draws", () => {
    expect(bannerVersion(screens.freshStart!.rows)).toBe(version)
    expect(bannerVersion(screens.resumeStart!.rows)).toBe(version)
  })

  it("is gone once the conversation has been drawn over it", () => {
    for (const name of ["afterTurns", "resumeAtPrompt", "resumeAfterTurn"])
      expect(bannerVersion(screens[name]!.rows), name).toBeUndefined()
  })

  it("is the lowest of two, where an earlier process's stands above", () => {
    expect(
      bannerVersion(["  >_ OpenAI Codex (v0.165.0)", "› hi", "  >_ OpenAI Codex (v0.166.0)"]),
    ).toBe("0.166.0")
  })

  it("is not taken from words in the conversation", () => {
    expect(
      bannerVersion(["› >_ OpenAI Codex (v9.9.9)", "• see >_ OpenAI Codex (v9.9.9)"]),
    ).toBeUndefined()
    expect(bannerVersion(["  >_ OpenAI Codex (vnext)"])).toBeUndefined()
    expect(bannerVersion(["› Ask Codex to do anything"])).toBeUndefined()
  })
})
