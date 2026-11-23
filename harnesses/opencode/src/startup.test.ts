import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { heldScreen, signedOut, title } from "./startup.js"

const { screens } = loadProbe<{ screens: { [name: string]: ScreenText } }>(
  import.meta.dirname,
  "dialogs.probe.json",
)

// Probed 2026-11-22, 1.19.6.
describe("opencode's start-up", () => {
  it("holds on no screen: it starts on its home screen with no provider, a bad key or no network", () => {
    for (const name of ["noProviders", "refused401", "noNetwork"]) {
      expect(heldScreen(screens[name]!.rows), name).toBeUndefined()
      expect(signedOut(screens[name]!.rows), name).toBe(false)
    }
  })

  it("shows its home screen as `OpenCode` and a session as `OC | <title>`", () => {
    expect(title("OpenCode", 5)).toEqual({
      type: "prompt-shown",
      agent: "opencode",
      instance: null,
      startedAt: 5,
    })
    expect(title("OC | Fix the login", 7)).toMatchObject({ type: "prompt-shown", startedAt: 7 })
  })

  it("is not told by another title, as one the person's shell sets", () => {
    for (const other of ["", "opencode", "OpenCode (1)", "zsh", "~/project", "OC|x"])
      expect(title(other, 1), other).toBeUndefined()
  })
})
