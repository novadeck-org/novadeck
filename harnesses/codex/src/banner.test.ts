import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { bannerVersion } from "./banner.js"

const { screens } = loadProbe(import.meta.dirname, "banner.probe.json") as {
  screens: { [name: string]: ScreenText }
}

describe("the version in Codex's banner, as captured", () => {
  it("names the release running at a fresh start and after a turn", () => {
    expect(bannerVersion(screens.freshStart!.rows)).toBe("0.165.0")
    expect(bannerVersion(screens.freshAfterTurn!.rows)).toBe("0.165.0")
  })

  it("names the release that resumed a session, not the one that began it", () => {
    expect(bannerVersion(screens.resumeStart!.rows)).toBe("0.166.0")
    expect(bannerVersion(screens.resumeAfterTurn!.rows)).toBe("0.166.0")
  })

  it("is not taken from words in the conversation, or once the banner has scrolled away", () => {
    expect(
      bannerVersion(["› >_ OpenAI Codex (v9.9.9)", "• see >_ OpenAI Codex (v9.9.9)"]),
    ).toBeUndefined()
    expect(bannerVersion(["  >_ OpenAI Codex (vnext)"])).toBeUndefined()
    expect(bannerVersion(["› Ask Codex to do anything"])).toBeUndefined()
  })
})
